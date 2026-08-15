import net from "node:net"
import { spawn as spawnChild } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Duration, Effect, Ref, Schedule, Schema } from "effect"
import {
  PACKAGE_VERSION,
  acquireStartupMarkerLease,
  inspectManagedRuntimeForDiscovery,
  resolveMusicSessionRuntimePaths,
  resolveMusicSessionStartup,
  type MusicSessionStartupOptions,
  type MusicSessionRuntimePaths,
  type StartupMarkerLease,
} from "./config.ts"
import { NdjsonFramer, encodeFrame } from "./framing.ts"
import {
  baselineCapabilities,
  decodeHelloResult,
  decodeServerFrame,
  PROTOCOL,
  type HostKind,
  type ProtocolError,
  type ProviderStatus,
  type ProtocolRange,
  type RevisionedState,
  type TransportAction,
  type TransportResult,
  decodeTransportResult,
} from "./protocol.ts"

export type MusicSessionClientOptions = {
  socketPath: string
  clientId: string
  hostKind: HostKind
  packageVersion?: string
  maxFrameBytes?: number
  protocolRange?: ProtocolRange
  capabilities?: string[]
}
export class MusicSessionClientError extends Error {
  readonly code: ProtocolError["code"]
  readonly retryable: boolean
  readonly details: ProtocolError["details"]
  constructor(
    error: ProtocolError,
    readonly transportCode?: string,
  ) {
    super(error.message)
    this.name = "MusicSessionClientError"
    this.code = error.code
    this.retryable = error.retryable
    this.details = error.details
  }
}
type Pending = {
  readonly id: number
  readonly action: TransportAction
  readonly resolve: (value: TransportResult) => void
  readonly reject: (error: MusicSessionClientError) => void
}
type Listener<T> = (value: T) => void
export type MusicSessionClient = {
  readonly daemonInstanceId: string
  readonly negotiatedCapabilities: string[]
  readonly selectedRevision: number
  readonly status: ProviderStatus | undefined
  readonly state: RevisionedState | undefined
  subscribeStatus(listener: Listener<ProviderStatus>): () => void
  subscribeState(listener: Listener<RevisionedState>): () => void
  toggle(): Promise<TransportResult>
  play(): Promise<TransportResult>
  pause(): Promise<TransportResult>
  next(): Promise<TransportResult>
  previous(): Promise<TransportResult>
  seek(positionMs: number): Promise<TransportResult>
  dispose(): void
}
class Client implements MusicSessionClient {
  #socket: net.Socket
  #framer: NdjsonFramer
  #nextId = 1
  #pending = new Map<number, Pending>()
  #disposed = false
  #failure: ProtocolError | undefined
  #terminal = false
  #status: ProviderStatus | undefined
  #state: RevisionedState | undefined
  #statusListeners = new Set<Listener<ProviderStatus>>()
  #stateListeners = new Set<Listener<RevisionedState>>()
  daemonInstanceId = ""
  negotiatedCapabilities: string[] = []
  selectedRevision = 0
  #phase: "handshaking" | "active" | "terminal" | "disposed" = "handshaking"
  #preHello: unknown[] = []
  #handshake:
    | {
        readonly offered: ProtocolRange
        readonly capabilities: string[]
        readonly resolve: () => void
        readonly reject: (error: MusicSessionClientError) => void
      }
    | undefined
  constructor(socket: net.Socket, framer: NdjsonFramer) {
    this.#socket = socket
    this.#framer = framer
  }
  get status() {
    return this.#status
  }
  get state() {
    return this.#state
  }
  #onData = (chunk: Buffer) => {
    try {
      for (const frame of this.#framer.push(chunk)) this.receive(frame)
    } catch {
      this.terminate({
        code: "CONNECTION_LOST",
        message: "invalid daemon frame",
        retryable: false,
      })
    }
  }
  #onError = () =>
    this.terminate({
      code: "CONNECTION_LOST",
      message: "connection lost",
      retryable: true,
    })
  #onEnd = () => {
    try {
      this.#framer.end()
      this.terminate({
        code: "CONNECTION_LOST",
        message: "connection ended",
        retryable: true,
      })
    } catch {
      this.terminate({
        code: "CONNECTION_LOST",
        message: "invalid daemon frame",
        retryable: false,
      })
    }
  }
  #onClose = () =>
    this.terminate({
      code: "CONNECTION_LOST",
      message: "connection closed",
      retryable: true,
    })
  attach() {
    this.#socket.on("data", this.#onData)
    this.#socket.on("error", this.#onError)
    this.#socket.on("end", this.#onEnd)
    this.#socket.on("close", this.#onClose)
  }
  private detach() {
    this.#socket.off("data", this.#onData)
    this.#socket.off("error", this.#onError)
    this.#socket.off("end", this.#onEnd)
    this.#socket.off("close", this.#onClose)
  }
  receive(raw: unknown) {
    if (this.#terminal || this.#disposed) return
    let frame: ReturnType<typeof decodeServerFrame>
    try {
      frame = decodeServerFrame(raw)
    } catch {
      this.terminate({
        code: "CONNECTION_LOST",
        message: "invalid daemon frame",
        retryable: false,
      })
      return
    }
    if (this.#phase === "handshaking") {
      if (frame.type !== "response" || frame.requestId !== 0) {
        this.#preHello.push(raw)
        return
      }
      if (!frame.ok) {
        this.terminate(frame.error)
        return
      }
      const handshake = this.#handshake!
      try {
        const result = decodeHelloResult(frame.data)
        if (
          result.protocol.major !== handshake.offered.major ||
          result.protocol.selectedRevision < handshake.offered.minRevision ||
          result.protocol.selectedRevision > handshake.offered.maxRevision ||
          !result.capabilities.includes("state-replay") ||
          result.capabilities.some(
            (capability) => !handshake.capabilities.includes(capability),
          )
        )
          throw new Error("impossible negotiated hello result")
        this.daemonInstanceId = result.daemonInstanceId
        this.negotiatedCapabilities = [...result.capabilities]
        this.selectedRevision = result.protocol.selectedRevision
        this.#phase = "active"
        this.#handshake = undefined
        for (const queued of this.#preHello.splice(0)) this.receive(queued)
        handshake.resolve()
      } catch {
        this.terminate({
          code: "INVALID_REQUEST",
          message: "invalid hello result",
          retryable: false,
        })
      }
      return
    }
    if (frame.type === "response") {
      const pending = this.#pending.get(frame.requestId)
      if (!pending) return
      if (!frame.ok) {
        this.settleFailure(pending, frame.error)
        return
      }
      try {
        const result = decodeTransportResult(frame.data)
        if (result.action !== pending.action)
          throw new Error("transport result action does not match request")
        this.settleSuccess(pending, result)
      } catch {
        this.terminate({
          code: "CONNECTION_LOST",
          message: "invalid daemon transport result",
          retryable: false,
        })
      }
      return
    }
    if (frame.type === "status") {
      this.#status = frame.status
      for (const listener of [...this.#statusListeners])
        try {
          listener(frame.status)
        } catch {}
      return
    }
    if (
      frame.snapshot.daemonInstanceId !== this.daemonInstanceId ||
      (this.#state && frame.snapshot.revision <= this.#state.revision)
    )
      return
    this.#state = frame.snapshot
    for (const listener of [...this.#stateListeners])
      try {
        listener(frame.snapshot)
      } catch {}
  }
  private settleSuccess(pending: Pending, result: TransportResult) {
    if (this.#pending.get(pending.id) !== pending) return
    this.#pending.delete(pending.id)
    pending.resolve(result)
  }
  private settleFailure(pending: Pending, error: ProtocolError) {
    if (this.#pending.get(pending.id) !== pending) return
    this.#pending.delete(pending.id)
    pending.reject(new MusicSessionClientError(error))
  }
  private request(
    action: TransportAction,
    positionMs?: number,
  ): Promise<TransportResult> {
    if (this.#disposed)
      return Promise.reject(
        new MusicSessionClientError({
          code: "DISPOSED",
          message: "client is disposed",
          retryable: false,
        }),
      )
    if (this.#failure)
      return Promise.reject(new MusicSessionClientError(this.#failure))
    if (this.#nextId > Number.MAX_SAFE_INTEGER)
      return Promise.reject(
        new MusicSessionClientError({
          code: "INVALID_REQUEST",
          message: "request ID space exhausted",
          retryable: false,
        }),
      )
    const requestId = this.#nextId++
    return new Promise<TransportResult>((resolve, reject) => {
      const pending: Pending = { id: requestId, action, resolve, reject }
      this.#pending.set(requestId, pending)
      try {
        this.#socket.write(
          encodeFrame({
            type: "transport",
            action,
            ...(positionMs === undefined ? {} : { positionMs }),
            requestId,
          }),
          (error) => {
            if (error) {
              this.terminate({
                code: "CONNECTION_LOST",
                message: error.message,
                retryable: true,
              })
            }
          },
        )
      } catch (cause) {
        this.terminate({
          code: "CONNECTION_LOST",
          message:
            cause instanceof Error ? cause.message : "connection write failed",
          retryable: true,
        })
      }
    })
  }
  private transport(action: TransportAction, positionMs?: number) {
    return this.request(action, positionMs)
  }
  toggle() {
    return this.transport("toggle")
  }
  play() {
    return this.transport("play")
  }
  pause() {
    return this.transport("pause")
  }
  next() {
    return this.transport("next")
  }
  previous() {
    return this.transport("previous")
  }
  seek(positionMs: number) {
    if (!Number.isSafeInteger(positionMs) || positionMs < 0)
      return Promise.reject(
        new MusicSessionClientError({
          code: "INVALID_SEEK",
          message: "seek position must be a non-negative safe integer",
          retryable: false,
        }),
      )
    return this.transport("seek", positionMs)
  }
  subscribeStatus(listener: Listener<ProviderStatus>) {
    if (this.#terminal || this.#disposed) return () => {}
    this.#statusListeners.add(listener)
    if (this.#status)
      try {
        listener(this.#status)
      } catch {}
    return () => this.#statusListeners.delete(listener)
  }
  subscribeState(listener: Listener<RevisionedState>) {
    if (this.#terminal || this.#disposed) return () => {}
    this.#stateListeners.add(listener)
    if (this.#state)
      try {
        listener(this.#state)
      } catch {}
    return () => this.#stateListeners.delete(listener)
  }
  beginHandshake(
    frame: string,
    offered: ProtocolRange,
    capabilities: string[],
  ): Promise<void> {
    this.attach()
    return new Promise<void>((resolve, reject) => {
      this.#handshake = { offered, capabilities, resolve, reject }
      try {
        this.#socket.write(frame, (error) => {
          if (error)
            this.terminate({
              code: "CONNECTION_LOST",
              message: error.message,
              retryable: true,
            })
        })
      } catch (cause) {
        this.terminate({
          code: "CONNECTION_LOST",
          message:
            cause instanceof Error ? cause.message : "connection write failed",
          retryable: true,
        })
      }
    })
  }
  private failAll(error: ProtocolError) {
    for (const pending of [...this.#pending.values()])
      this.settleFailure(pending, error)
  }
  private terminate(error: ProtocolError) {
    if (this.#terminal || this.#disposed) return
    this.#terminal = true
    this.#phase = "terminal"
    this.#failure = error
    const handshake = this.#handshake
    this.#handshake = undefined
    this.detach()
    handshake?.reject(new MusicSessionClientError(error))
    this.#statusListeners.clear()
    this.#stateListeners.clear()
    this.failAll({
      code: "INDETERMINATE_COMMAND",
      message: "connection ended before command result",
      retryable: true,
    })
    if (!this.#socket.destroyed) this.#socket.destroy()
  }
  dispose() {
    if (this.#disposed || this.#terminal) return
    this.#disposed = true
    this.#terminal = true
    this.#phase = "disposed"
    const handshake = this.#handshake
    this.#handshake = undefined
    this.detach()
    handshake?.reject(
      new MusicSessionClientError({
        code: "DISPOSED",
        message: "client is disposed",
        retryable: false,
      }),
    )
    this.#statusListeners.clear()
    this.#stateListeners.clear()
    this.failAll({
      code: "DISPOSED",
      message: "client is disposed",
      retryable: false,
    })
    this.#socket.destroy()
  }
}
export async function createMusicSessionClient(
  options: MusicSessionClientOptions,
): Promise<MusicSessionClient> {
  if (!options.socketPath)
    throw new MusicSessionClientError({
      code: "INVALID_REQUEST",
      message: "socketPath is required",
      retryable: false,
    })
  const offered = options.protocolRange ?? PROTOCOL
  const capabilities = options.capabilities ?? [...baselineCapabilities]
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === "string")
  )
    throw new MusicSessionClientError({
      code: "INVALID_REQUEST",
      message: "capabilities must be strings",
      retryable: false,
    })
  if (
    !Number.isSafeInteger(offered.major) ||
    !Number.isSafeInteger(offered.minRevision) ||
    !Number.isSafeInteger(offered.maxRevision) ||
    offered.major < 0 ||
    offered.minRevision < 0 ||
    offered.maxRevision < offered.minRevision
  )
    throw new MusicSessionClientError({
      code: "INVALID_REQUEST",
      message: "invalid protocol revision range",
      retryable: false,
    })
  const socket = net.createConnection(options.socketPath)
  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      socket.off("error", onError)
      resolve()
    }
    const onError = (cause: Error) => {
      socket.off("connect", onConnect)
      reject(cause)
    }
    socket.once("connect", onConnect)
    socket.once("error", onError)
  }).catch((cause: unknown) => {
    socket.destroy()
    const transportCode =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : undefined
    throw new MusicSessionClientError(
      {
        code: "CONNECTION_LOST",
        message: cause instanceof Error ? cause.message : "connection failed",
        retryable: true,
      },
      transportCode,
    )
  })
  const client = new Client(socket, new NdjsonFramer(options.maxFrameBytes))
  await client.beginHandshake(
    encodeFrame({
      type: "hello",
      requestId: 0,
      protocol: offered,
      packageVersion: options.packageVersion ?? PACKAGE_VERSION,
      clientId: options.clientId,
      hostKind: options.hostKind,
      capabilities,
    }),
    offered,
    capabilities,
  )
  return client
}

export type MusicSessionDiscoveryOptions = Omit<
  MusicSessionClientOptions,
  "socketPath"
> & {
  /** Test-only alternate secure runtime layout; production omits this. */
  runtime?: MusicSessionRuntimePaths
  /** Internal opaque lease: discovery may ignore only this exact owned marker. */
  ownedLease?: StartupMarkerLease
}
export type MusicSessionDiscovery =
  | {
      readonly type: "healthy"
      readonly client: MusicSessionClient
      readonly cleanup?: () => Promise<void>
    }
  | { readonly type: "incompatible"; readonly error: MusicSessionClientError }
  | { readonly type: "missing" }
  | { readonly type: "starting" }
  | { readonly type: "occupied" }
  | { readonly type: "stale"; readonly cleanup: () => Promise<void> }

/**
 * Performs one managed-runtime inspection and hello. It intentionally never
 * starts, signals, retries, or replaces a daemon generation.
 */
export async function discoverMusicSession(
  options: MusicSessionDiscoveryOptions,
): Promise<MusicSessionDiscovery> {
  const runtime = options.runtime ?? resolveMusicSessionRuntimePaths()
  const probe = await inspectManagedRuntimeForDiscovery(
    runtime,
    options.ownedLease,
  )
  const nonEndpoint = async () => {
    const result = probe.socketPath
      ? await probe.refused()
      : await probe.absent()
    switch (result.type) {
      case "stale":
      case "starting":
      case "occupied":
      case "missing":
        return result
      default:
        throw new Error("invalid managed runtime probe result")
    }
  }
  if (!probe.socketPath) return nonEndpoint()
  try {
    const client = await createMusicSessionClient({
      ...options,
      socketPath: probe.socketPath,
    })
    const found = await probe.healthy(client)
    if (found.type !== "healthy")
      throw new Error("invalid managed runtime healthy probe")
    return found.cleanup
      ? { type: "healthy", client, cleanup: found.cleanup }
      : { type: "healthy", client }
  } catch (cause) {
    if (
      cause instanceof MusicSessionClientError &&
      cause.code === "INCOMPATIBLE_PROTOCOL"
    )
      return { type: "incompatible", error: cause }
    if (
      cause instanceof MusicSessionClientError &&
      cause.transportCode &&
      ["ECONNREFUSED", "ENOENT"].includes(cause.transportCode)
    )
      return nonEndpoint()
    return { type: "occupied" }
  }
}

/** Compatibility spelling for callers that name the operation an endpoint probe. */
export const discoverMusicSessionEndpoint = discoverMusicSession

export class MusicSessionStartupError extends Schema.TaggedErrorClass<MusicSessionStartupError>()(
  "MusicSession.StartupError",
  {
    operation: Schema.Union([
      Schema.Literal("spawn"),
      Schema.Literal("timeout"),
      Schema.Literal("occupied"),
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

type SpawnedDaemon = {
  once(event: "spawn" | "error", listener: (cause?: Error) => void): unknown
  off(event: "spawn" | "error", listener: (cause?: Error) => void): unknown
  unref(): void
}
export type MusicSessionDaemonLauncher = (
  runtime: MusicSessionRuntimePaths,
) => Promise<void>
type ManagedSpawnOptions = {
  readonly detached: true
  readonly stdio: "ignore"
  readonly shell: false
  readonly env: NodeJS.ProcessEnv
}
export type MusicSessionDaemonLauncherDependencies = {
  readonly entry: () => string
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: ManagedSpawnOptions,
  ) => SpawnedDaemon
}
const productionLauncherDependencies: MusicSessionDaemonLauncherDependencies = {
  entry: () =>
    fileURLToPath(new URL("../dist/music-sessiond.js", import.meta.url)),
  spawn: (command, args, options) => spawnChild(command, args, options),
}

/** Narrow process boundary; the managed daemon receives no socket override. */
export const launchManagedMusicSessionDaemon = async (
  _runtime: MusicSessionRuntimePaths,
  dependencies: MusicSessionDaemonLauncherDependencies = productionLauncherDependencies,
): Promise<void> => {
  let child: SpawnedDaemon
  try {
    child = dependencies.spawn(process.execPath, [dependencies.entry()], {
      detached: true,
      stdio: "ignore",
      shell: false,
      env: { PATH: process.env.PATH ?? "" },
    })
  } catch (cause) {
    throw new MusicSessionStartupError({
      operation: "spawn",
      message: "unable to spawn music session daemon",
      cause,
    })
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", spawned)
      child.off("error", failed)
    }
    const spawned = () => {
      cleanup()
      child.unref()
      resolve()
    }
    const failed = (cause?: Error) => {
      cleanup()
      reject(
        new MusicSessionStartupError({
          operation: "spawn",
          message: "unable to spawn music session daemon",
          cause,
        }),
      )
    }
    child.once("spawn", spawned)
    child.once("error", failed)
  })
}

export type ConnectOrStartMusicSessionOptions = MusicSessionDiscoveryOptions & {
  readonly launcher?: MusicSessionDaemonLauncher
  /** Resolved through the tagged config boundary before scheduling. */
  readonly startup?: MusicSessionStartupOptions
}

const startupSchedule = (
  attempts: number,
  initialDelayMs: number,
  maxDelayMs: number,
) =>
  Schedule.exponential(Duration.millis(initialDelayMs)).pipe(
    Schedule.jittered,
    // Cap the final jittered duration, never merely its pre-jitter input.
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.millis(maxDelayMs))),
    ),
    Schedule.upTo({ times: attempts }),
  )

/**
 * Managed startup coordinator. It never sends commands or owns a reconnecting
 * client; a returned client belongs solely to its caller.
 */
class StartupPending extends Error {
  readonly _tag = "MusicSession.StartupPending"
}

/**
 * Managed startup coordinator. Pending discovery alone is retried; every
 * terminal endpoint, launch, and protocol error remains visible immediately.
 */
export const connectOrStartMusicSessionEffect = (
  options: ConnectOrStartMusicSessionOptions,
) => {
  const runtime = options.runtime ?? resolveMusicSessionRuntimePaths()
  const launcher = options.launcher ?? launchManagedMusicSessionDaemon
  // Preserve errors from the secure discovery/lease/launcher boundaries. Only
  // schedule exhaustion below is translated to the startup timeout operation.
  const promise = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new MusicSessionStartupError({
              operation: "timeout",
              message: "music session startup operation failed",
              cause,
            }),
    })
  return Effect.gen(function* () {
    const { attempts, initialDelayMs, maxDelayMs } =
      yield* resolveMusicSessionStartup(options.startup)
    const lease = yield* Ref.make<StartupMarkerLease | undefined>(undefined)
    const spawned = yield* Ref.make(false)
    const attempt = Effect.gen(function* () {
      const ownedLease = yield* Ref.get(lease)
      const discovery = yield* promise(() =>
        discoverMusicSession({
          ...options,
          runtime,
          ...(ownedLease ? { ownedLease } : {}),
        }),
      )
      if (discovery.type === "healthy") {
        if (discovery.cleanup)
          yield* promise(async () => {
            try {
              await discovery.cleanup?.()
            } catch (cause) {
              discovery.client.dispose()
              throw cause
            }
          })
        return discovery.client
      }
      if (discovery.type === "incompatible")
        return yield* Effect.fail(discovery.error)
      if (discovery.type === "occupied")
        return yield* Effect.fail(
          new MusicSessionStartupError({
            operation: "occupied",
            message:
              "music session endpoint is occupied by an unclassifiable peer",
          }),
        )
      if (discovery.type === "stale") {
        yield* promise(discovery.cleanup)
        return yield* Effect.fail(new StartupPending())
      }
      if (discovery.type === "missing" && !ownedLease) {
        // Once exclusive acquisition returns a lease, recording it for the
        // finalizer is uninterruptible; cancellation cannot strand a marker.
        yield* Effect.uninterruptible(
          promise(() => acquireStartupMarkerLease(runtime)).pipe(
            Effect.tap((next) =>
              next.type === "acquired"
                ? Ref.set(lease, next.lease)
                : Effect.void,
            ),
          ),
        )
        return yield* Effect.fail(new StartupPending())
      }
      if (discovery.type === "missing" && ownedLease) {
        if (!(yield* Ref.get(spawned))) {
          yield* Ref.set(spawned, true)
          yield* promise(() => launcher(runtime))
        }
        return yield* Effect.fail(new StartupPending())
      }
      return yield* Effect.fail(new StartupPending())
    })
    return yield* attempt.pipe(
      Effect.retry({
        schedule: startupSchedule(attempts - 1, initialDelayMs, maxDelayMs),
        while: (error) => error instanceof StartupPending,
      }),
      Effect.catchIf(
        (error): error is StartupPending => error instanceof StartupPending,
        () =>
          Effect.fail(
            new MusicSessionStartupError({
              operation: "timeout",
              message: "music session startup timed out",
            }),
          ),
      ),
      Effect.ensuring(
        Ref.get(lease).pipe(
          Effect.flatMap((ownedLease) =>
            ownedLease
              ? Effect.matchEffect(
                  promise(() => ownedLease.release()),
                  {
                    onSuccess: () => Effect.void,
                    onFailure: (error) =>
                      Effect.logWarning(
                        "music session startup marker release failed",
                        error,
                      ),
                  },
                )
              : Effect.void,
          ),
        ),
      ),
    )
  })
}

/** Thin Promise boundary for existing callers. */
export const connectOrStartMusicSession = (
  options: ConnectOrStartMusicSessionOptions,
): Promise<MusicSessionClient> =>
  Effect.runPromise(connectOrStartMusicSessionEffect(options))

/** Promise adapter spelling retained for callers that use the shorter name. */
export const connectOrStart = connectOrStartMusicSession
