import net from "node:net"
import { spawn as spawnChild } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Ref,
  Schedule,
  Schema,
  Scope,
} from "effect"
import {
  PACKAGE_VERSION,
  acquireStartupMarkerLease,
  MusicSessionConfigError,
  MusicSessionRuntimeError,
  inspectManagedRuntimeForDiscovery,
  resolveMusicSessionRuntimePaths,
  resolveMusicSessionStartup,
  type MusicSessionStartupOptions,
  type MusicSessionRuntimePaths,
  type StartupMarkerLease,
  type StartupMarkerLeaseResult,
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
  /** Exact retained terminal observation; disposal never emits a loss. */
  subscribeTerminal(listener: Listener<MusicSessionClientError>): () => void
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
  #terminalError: MusicSessionClientError | undefined
  #terminalListeners = new Set<Listener<MusicSessionClientError>>()
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
  subscribeTerminal(listener: Listener<MusicSessionClientError>) {
    if (this.#terminalError) {
      try {
        listener(this.#terminalError)
      } catch {}
      return () => {}
    }
    if (this.#disposed) return () => {}
    this.#terminalListeners.add(listener)
    return () => this.#terminalListeners.delete(listener)
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
    const terminal = new MusicSessionClientError(error)
    this.#terminalError = terminal
    const handshake = this.#handshake
    this.#handshake = undefined
    this.detach()
    handshake?.reject(terminal)
    for (const listener of [...this.#terminalListeners])
      try {
        listener(terminal)
      } catch {}
    this.#terminalListeners.clear()
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
    if (this.#disposed) return
    this.#disposed = true
    if (this.#terminal) {
      this.#terminalListeners.clear()
      this.#statusListeners.clear()
      this.#stateListeners.clear()
      return
    }
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
    this.#terminalListeners.clear()
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
export type ConnectOrStartMusicSessionDependencies = {
  /** Test seam for one managed endpoint probe; production uses discovery. */
  readonly discover?: (
    options: MusicSessionDiscoveryOptions,
  ) => Promise<MusicSessionDiscovery>
  /** Test seam for exclusive marker acquisition. */
  readonly acquireLease?: (
    runtime: MusicSessionRuntimePaths,
  ) => Promise<StartupMarkerLeaseResult>
  /** Synchronous, bounded lifecycle observations; thrown observer errors ignored. */
  readonly onAttempt?: () => void
  readonly onReleaseFailure?: (error: unknown) => void
}

export const connectOrStartMusicSessionEffect = (
  options: ConnectOrStartMusicSessionOptions,
  dependencies: ConnectOrStartMusicSessionDependencies = {},
) => {
  const runtime = options.runtime ?? resolveMusicSessionRuntimePaths()
  const launcher = options.launcher ?? launchManagedMusicSessionDaemon
  const discover = dependencies.discover ?? discoverMusicSession
  const acquireLease = dependencies.acquireLease ?? acquireStartupMarkerLease
  const observe = (callback: (() => void) | undefined) => {
    try {
      callback?.()
    } catch {}
  }
  const observeReleaseFailure = (error: unknown) => {
    try {
      dependencies.onReleaseFailure?.(error)
    } catch {}
  }
  // Preserve errors from the secure discovery/lease/launcher boundaries. Only
  // schedule exhaustion below is translated to the startup timeout operation.
  const disposeLateClient = (value: unknown) => {
    const candidate =
      typeof value === "object" && value !== null && "client" in value
        ? value.client
        : value
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "dispose" in candidate &&
      typeof candidate.dispose === "function"
    )
      try {
        candidate.dispose()
      } catch {}
  }
  const promise = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      // Promise-backed discovery/hello cannot be force-cancelled by Effect.
      // If it wins after interruption, it may contain a live explicit client;
      // dispose that late value rather than losing the socket ownership.
      try: (signal) =>
        run().then((value) => {
          if (signal.aborted) {
            disposeLateClient(value)
            throw new MusicSessionClientError({
              code: "DISPOSED",
              message: "music session startup was interrupted",
              retryable: false,
            })
          }
          return value
        }),
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
    const releaseOwned = Effect.uninterruptible(
      Ref.getAndSet(lease, undefined).pipe(
        Effect.flatMap((ownedLease) =>
          ownedLease
            ? promise(() => ownedLease.release()).pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => observeReleaseFailure(error)).pipe(
                    Effect.andThen(
                      Effect.logWarning(
                        "music session startup marker release failed",
                      ),
                    ),
                  ),
                ),
              )
            : Effect.void,
        ),
      ),
    )
    const attempt = Effect.gen(function* () {
      yield* Effect.sync(() => observe(dependencies.onAttempt))
      const ownedLease = yield* Ref.get(lease)
      const discovery = yield* promise(() =>
        discover({
          ...options,
          runtime,
          ...(ownedLease ? { ownedLease } : {}),
        }),
      )
      if (discovery.type === "healthy")
        return yield* Effect.onInterrupt(
          Effect.gen(function* () {
            if (discovery.cleanup)
              yield* promise(async () => {
                try {
                  await discovery.cleanup?.()
                } catch (cause) {
                  discovery.client.dispose()
                  throw cause
                }
              })
            if (!ownedLease) return discovery.client
            return yield* releaseOwned.pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.sync(() => discovery.client.dispose()).pipe(
                    Effect.andThen(Effect.fail(error)),
                  ),
                onSuccess: () => Effect.succeed(discovery.client),
              }),
            )
          }),
          () => Effect.sync(() => discovery.client.dispose()),
        )
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
          promise(() => acquireLease(runtime)).pipe(
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
      Effect.ensuring(releaseOwned.pipe(Effect.catch(() => Effect.void))),
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

type ManagedTerminalError =
  | MusicSessionClientError
  | MusicSessionStartupError
  | MusicSessionRuntimeError
  | MusicSessionConfigError

export type MusicSessionConnectionLifecycle =
  | { readonly type: "connecting" }
  | { readonly type: "connected"; readonly daemonInstanceId: string }
  | {
      readonly type: "reconnecting"
      readonly error: MusicSessionClientError
    }
  | { readonly type: "terminal"; readonly error: ManagedTerminalError }
  | { readonly type: "disposed" }

/** A separately typed, host-neutral owner for managed daemon generations. */
export type ReconnectingMusicSessionClient = {
  readonly daemonInstanceId: string
  readonly negotiatedCapabilities: string[]
  readonly selectedRevision: number
  readonly status: ProviderStatus | undefined
  readonly state: RevisionedState | undefined
  readonly connection: MusicSessionConnectionLifecycle
  subscribeStatus(listener: Listener<ProviderStatus>): () => void
  subscribeState(listener: Listener<RevisionedState>): () => void
  subscribeConnection(
    listener: Listener<MusicSessionConnectionLifecycle>,
  ): () => void
  toggle(): Promise<TransportResult>
  play(): Promise<TransportResult>
  pause(): Promise<TransportResult>
  next(): Promise<TransportResult>
  previous(): Promise<TransportResult>
  seek(positionMs: number): Promise<TransportResult>
  /** Resolves only after the active generation and supervisor have stopped. */
  dispose(): Promise<void>
}

export type ReconnectingMusicSessionClientOptions =
  ConnectOrStartMusicSessionOptions

type ReconnectingConnector = (
  options: ReconnectingMusicSessionClientOptions,
) => Effect.Effect<MusicSessionClient, Error>

/** Test-only connector seam; production always uses the Phase 3 workflow. */
export type ReconnectingMusicSessionClientDependencies = {
  readonly connect?: ReconnectingConnector
  /** Test-only hook after a completed client is atomically reserved. */
  readonly onReserved?: () => void
}

type ActiveGeneration = {
  readonly token: number
  readonly client: MusicSessionClient
  unsubscribeStatus: () => void
  unsubscribeState: () => void
  unsubscribeTerminal: () => void
}

type ManagedLifecycleState = {
  readonly token: number
  readonly active: ActiveGeneration | undefined
  readonly pending: MusicSessionClient | undefined
  readonly disposed: boolean
  readonly terminal: ManagedTerminalError | undefined
  readonly status: ProviderStatus | undefined
  readonly state: RevisionedState | undefined
  readonly lifecycle: MusicSessionConnectionLifecycle
  readonly statusListeners: Set<Listener<ProviderStatus>>
  readonly stateListeners: Set<Listener<RevisionedState>>
  readonly connectionListeners: Set<Listener<MusicSessionConnectionLifecycle>>
  readonly interrupt: (() => Promise<void>) | undefined
  readonly closeScope: (() => Promise<void>) | undefined
  readonly dispose: Promise<void> | undefined
}

const asManagedTerminal = (cause: unknown): ManagedTerminalError =>
  cause instanceof MusicSessionClientError ||
  cause instanceof MusicSessionStartupError ||
  cause instanceof MusicSessionRuntimeError ||
  cause instanceof MusicSessionConfigError
    ? cause
    : new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message:
          cause instanceof Error
            ? cause.message
            : "music session connection failed",
        retryable: false,
      })

class ManagedMusicSessionClient implements ReconnectingMusicSessionClient {
  // Socket callbacks and scope finalizers share one synchronous Effect Ref.
  // Accessors below keep the Promise-facing contract synchronous while every
  // lifecycle transition is serialized through Ref.update.
  #managed = Ref.makeUnsafe<ManagedLifecycleState>({
    token: 0,
    active: undefined,
    pending: undefined,
    disposed: false,
    terminal: undefined,
    status: undefined,
    state: undefined,
    lifecycle: { type: "connecting" },
    statusListeners: new Set(),
    stateListeners: new Set(),
    connectionListeners: new Set(),
    interrupt: undefined,
    closeScope: undefined,
    dispose: undefined,
  })
  #replace(next: Partial<ManagedLifecycleState>) {
    Effect.runSync(
      Ref.update(this.#managed, (current) => ({ ...current, ...next })),
    )
  }
  #modify<A>(
    f: (current: ManagedLifecycleState) => readonly [A, ManagedLifecycleState],
  ) {
    return Effect.runSync(Ref.modify(this.#managed, f))
  }
  get #active() {
    return Ref.getUnsafe(this.#managed).active
  }
  set #active(active: ActiveGeneration | undefined) {
    this.#replace({ active })
  }
  get #disposed() {
    return Ref.getUnsafe(this.#managed).disposed
  }
  set #disposed(disposed: boolean) {
    this.#replace({ disposed })
  }
  get #terminal() {
    return Ref.getUnsafe(this.#managed).terminal
  }
  set #terminal(terminal: ManagedTerminalError | undefined) {
    this.#replace({ terminal })
  }
  get #status() {
    return Ref.getUnsafe(this.#managed).status
  }
  set #status(status: ProviderStatus | undefined) {
    this.#replace({ status })
  }
  get #state() {
    return Ref.getUnsafe(this.#managed).state
  }
  set #state(state: RevisionedState | undefined) {
    this.#replace({ state })
  }
  get #lifecycle() {
    return Ref.getUnsafe(this.#managed).lifecycle
  }
  set #lifecycle(lifecycle: MusicSessionConnectionLifecycle) {
    this.#replace({ lifecycle })
  }
  #initial = Deferred.makeUnsafe<
    ReconnectingMusicSessionClient,
    ManagedTerminalError
  >()

  constructor(
    readonly options: ReconnectingMusicSessionClientOptions,
    readonly connect: ReconnectingConnector = connectOrStartMusicSessionEffect,
    readonly onReserved: (() => void) | undefined = undefined,
  ) {}

  get daemonInstanceId() {
    return this.#active?.client.daemonInstanceId ?? ""
  }
  get negotiatedCapabilities() {
    return this.#active ? [...this.#active.client.negotiatedCapabilities] : []
  }
  get selectedRevision() {
    return this.#active?.client.selectedRevision ?? 0
  }
  get status() {
    return this.#status
  }
  get state() {
    return this.#state
  }
  get connection() {
    return this.#lifecycle
  }

  setOwner(interrupt: () => Promise<void>) {
    this.#modify((current) => [undefined, { ...current, interrupt }])
  }
  setScopeCloser(closeScope: () => Promise<void>) {
    this.#modify((current) => [undefined, { ...current, closeScope }])
  }
  awaitInitial() {
    return Deferred.await(this.#initial)
  }

  #notify<A>(listeners: Set<Listener<A>>, value: A) {
    for (const listener of [...listeners])
      try {
        listener(value)
      } catch {}
  }
  #setConnection(next: MusicSessionConnectionLifecycle) {
    const listeners = this.#modify((current) => {
      if (current.disposed && next.type !== "disposed") return [[], current]
      return [
        [...current.connectionListeners],
        { ...current, lifecycle: next },
      ] as const
    })
    this.#notify(new Set(listeners), next)
  }
  #isCurrent(token: number) {
    const current = Ref.getUnsafe(this.#managed)
    return !current.disposed && current.active?.token === token
  }
  #release(active: ActiveGeneration | undefined, dispose = false) {
    if (!active) return
    active.unsubscribeStatus()
    active.unsubscribeState()
    active.unsubscribeTerminal()
    if (dispose) active.client.dispose()
  }
  #reserve(client: MusicSessionClient) {
    const reserved = this.#modify((current) =>
      current.disposed
        ? [false, current]
        : [true, { ...current, pending: client }],
    )
    if (!reserved) {
      client.dispose()
      return false
    }
    try {
      this.onReserved?.()
    } catch {}
    return true
  }
  #unavailable() {
    if (this.#terminal) return this.#terminal
    return new MusicSessionClientError({
      code: this.#disposed ? "DISPOSED" : "CONNECTION_LOST",
      message: this.#disposed
        ? "managed music session client is disposed"
        : "managed music session client is reconnecting",
      retryable: !this.#disposed,
    })
  }
  #command(action: "toggle" | "play" | "pause" | "next" | "previous") {
    const active = this.#active
    return active
      ? active.client[action]()
      : Promise.reject(this.#unavailable())
  }
  toggle() {
    return this.#command("toggle")
  }
  play() {
    return this.#command("play")
  }
  pause() {
    return this.#command("pause")
  }
  next() {
    return this.#command("next")
  }
  previous() {
    return this.#command("previous")
  }
  seek(positionMs: number) {
    const active = this.#active
    return active
      ? active.client.seek(positionMs)
      : Promise.reject(this.#unavailable())
  }
  subscribeStatus(listener: Listener<ProviderStatus>) {
    const replay = this.#modify((current) =>
      current.disposed
        ? [undefined, current]
        : [
            current.status,
            {
              ...current,
              statusListeners: new Set([...current.statusListeners, listener]),
            },
          ],
    )
    if (replay)
      try {
        listener(replay)
      } catch {}
    return () =>
      this.#modify((current) => [
        undefined,
        {
          ...current,
          statusListeners: new Set(
            [...current.statusListeners].filter((value) => value !== listener),
          ),
        },
      ])
  }
  subscribeState(listener: Listener<RevisionedState>) {
    const replay = this.#modify((current) =>
      current.disposed
        ? [undefined, current]
        : [
            current.state,
            {
              ...current,
              stateListeners: new Set([...current.stateListeners, listener]),
            },
          ],
    )
    if (replay)
      try {
        listener(replay)
      } catch {}
    return () =>
      this.#modify((current) => [
        undefined,
        {
          ...current,
          stateListeners: new Set(
            [...current.stateListeners].filter((value) => value !== listener),
          ),
        },
      ])
  }
  subscribeConnection(listener: Listener<MusicSessionConnectionLifecycle>) {
    const replay = this.#modify((current) =>
      current.disposed
        ? [undefined, current]
        : [
            current.lifecycle,
            {
              ...current,
              connectionListeners: new Set([
                ...current.connectionListeners,
                listener,
              ]),
            },
          ],
    )
    if (replay)
      try {
        listener(replay)
      } catch {}
    return () =>
      this.#modify((current) => [
        undefined,
        {
          ...current,
          connectionListeners: new Set(
            [...current.connectionListeners].filter(
              (value) => value !== listener,
            ),
          ),
        },
      ])
  }

  #terminalFor(
    token: number,
    error: MusicSessionClientError,
    done: Deferred.Deferred<MusicSessionClientError>,
  ) {
    const transition = this.#modify((current) => {
      if (current.disposed || current.active?.token !== token)
        return [undefined, current]
      const lifecycle: MusicSessionConnectionLifecycle = error.retryable
        ? { type: "reconnecting", error }
        : { type: "terminal", error }
      return [
        { active: current.active, lifecycle },
        {
          ...current,
          active: undefined,
          terminal: error.retryable ? current.terminal : error,
          lifecycle,
        },
      ] as const
    })
    if (!transition) return
    this.#release(transition.active)
    this.#notify(
      new Set(Ref.getUnsafe(this.#managed).connectionListeners),
      transition.lifecycle,
    )
    if (!error.retryable) Deferred.doneUnsafe(this.#initial, Effect.fail(error))
    Deferred.doneUnsafe(done, Effect.succeed(error))
  }
  #adopt(
    token: number,
    client: MusicSessionClient,
    done: Deferred.Deferred<MusicSessionClientError>,
  ) {
    const active: ActiveGeneration = {
      token,
      client,
      unsubscribeStatus: () => {},
      unsubscribeState: () => {},
      unsubscribeTerminal: () => {},
    }
    const prior = this.#modify<
      | { readonly accepted: false }
      | {
          readonly accepted: true
          readonly active: ActiveGeneration | undefined
        }
    >((current) => {
      if (
        current.disposed ||
        token !== current.token ||
        current.pending !== client
      )
        return [{ accepted: false as const }, current]
      return [
        { accepted: true as const, active: current.active },
        { ...current, pending: undefined, active },
      ]
    })
    if (!prior.accepted) {
      client.dispose()
      return false
    }
    this.#release(prior.active, true)
    active.unsubscribeStatus = client.subscribeStatus((status) => {
      const listeners = this.#modify((current) =>
        !current.disposed && current.active?.token === token
          ? [[...current.statusListeners], { ...current, status }]
          : [[], current],
      )
      this.#notify(new Set(listeners), status)
    })
    active.unsubscribeState = client.subscribeState((state) => {
      const listeners = this.#modify((current) =>
        !current.disposed && current.active?.token === token
          ? [[...current.stateListeners], { ...current, state }]
          : [[], current],
      )
      this.#notify(new Set(listeners), state)
    })
    active.unsubscribeTerminal = client.subscribeTerminal((error) =>
      this.#terminalFor(token, error, done),
    )
    if (!this.#isCurrent(token)) return false
    this.#setConnection({
      type: "connected",
      daemonInstanceId: client.daemonInstanceId,
    })
    return true
  }
  #finish(error: ManagedTerminalError) {
    const transition = this.#modify<
      | {
          readonly changed: false
          readonly listeners: Listener<MusicSessionConnectionLifecycle>[]
        }
      | {
          readonly changed: true
          readonly listeners: Listener<MusicSessionConnectionLifecycle>[]
        }
    >((current) => {
      if (current.disposed || current.terminal)
        return [{ changed: false as const, listeners: [] }, current]
      return [
        {
          changed: true as const,
          listeners: [...current.connectionListeners],
        },
        { ...current, terminal: error, lifecycle: { type: "terminal", error } },
      ]
    })
    if (!transition.changed) return
    this.#notify(new Set(transition.listeners), { type: "terminal", error })
    Deferred.doneUnsafe(this.#initial, Effect.fail(error))
  }
  #nextToken() {
    return this.#modify((current) =>
      current.disposed
        ? [undefined, current]
        : [current.token + 1, { ...current, token: current.token + 1 }],
    )
  }
  shutdown() {
    const transition = this.#modify((current) => {
      if (current.disposed) return [undefined, current]
      return [
        {
          active: current.active,
          pending: current.pending,
          listeners: [...current.connectionListeners],
        },
        {
          ...current,
          disposed: true,
          token: current.token + 1,
          active: undefined,
          pending: undefined,
          lifecycle: { type: "disposed" },
          statusListeners: new Set(),
          stateListeners: new Set(),
          connectionListeners: new Set(),
        },
      ] as const
    })
    if (!transition) return
    this.#release(transition.active, true)
    transition.pending?.dispose()
    this.#notify(new Set(transition.listeners), { type: "disposed" })
    Deferred.doneUnsafe(
      this.#initial,
      Effect.fail(
        new MusicSessionClientError({
          code: "DISPOSED",
          message: "managed music session client is disposed",
          retryable: false,
        }),
      ),
    )
  }
  dispose() {
    let resolve: (() => void) | undefined
    const completion = new Promise<void>((next) => {
      resolve = next
    })
    const winner = this.#modify((current) => {
      if (current.dispose) return [undefined, current]
      return [
        {
          close: current.closeScope ?? current.interrupt ?? (async () => {}),
          completion,
        },
        { ...current, dispose: completion },
      ] as const
    })
    if (!winner) return Ref.getUnsafe(this.#managed).dispose ?? completion
    void winner
      .close()
      .catch(() => {})
      .then(() => {
        this.shutdown()
        resolve?.()
      })
    return winner.completion
  }

  supervisor() {
    const managed = this
    return Effect.gen(function* () {
      let initial = true
      while (!managed.#disposed) {
        const token = managed.#nextToken()
        if (token === undefined) return
        const loss = Deferred.makeUnsafe<MusicSessionClientError>()
        if (initial) managed.#setConnection({ type: "connecting" })
        else if (managed.#lifecycle.type !== "reconnecting")
          managed.#setConnection({
            type: "reconnecting",
            error: new MusicSessionClientError({
              code: "CONNECTION_LOST",
              message: "connection lost",
              retryable: true,
            }),
          })
        // `restore` keeps acquisition interruptible; once it succeeds, the
        // surrounding uninterruptible mask reserves the client before an
        // interruption can strand it between connect and adoption.
        const result = yield* Effect.uninterruptibleMask((restore) =>
          restore(managed.connect(managed.options)).pipe(
            Effect.tap((client) => Effect.sync(() => managed.#reserve(client))),
          ),
        ).pipe(
          Effect.match({
            onFailure: (cause) => ({ type: "failure" as const, cause }),
            onSuccess: (client) => ({ type: "success" as const, client }),
          }),
        )
        if (result.type === "failure") {
          managed.#finish(asManagedTerminal(result.cause))
          return
        }
        if (!managed.#adopt(token, result.client, loss)) {
          if (managed.#terminal) return
          continue
        }
        if (initial) {
          initial = false
          Deferred.doneUnsafe(managed.#initial, Effect.succeed(managed))
        }
        const terminal = yield* Deferred.await(loss)
        if (!terminal.retryable) return
      }
    })
  }
}

/** Scoped Effect constructor for the managed reconnect supervisor. */
export const createReconnectingMusicSessionClientEffect = (
  options: ReconnectingMusicSessionClientOptions,
  dependencies: ReconnectingMusicSessionClientDependencies = {},
) =>
  Effect.gen(function* () {
    const managed = new ManagedMusicSessionClient(
      options,
      dependencies.connect,
      dependencies.onReserved,
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => managed.shutdown()))
    const fiber = yield* managed.supervisor().pipe(Effect.forkScoped)
    managed.setOwner(() => Effect.runPromise(Fiber.interrupt(fiber)))
    return yield* managed.awaitInitial()
  })

/** Promise-facing owner for one scoped managed reconnect supervisor. */
export const createReconnectingMusicSessionClient = async (
  options: ReconnectingMusicSessionClientOptions,
): Promise<ReconnectingMusicSessionClient> => {
  const scope = await Effect.runPromise(Scope.make())
  try {
    const managed = (await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(options).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    )) as ManagedMusicSessionClient
    managed.setScopeCloser(() =>
      Effect.runPromise(Scope.close(scope, Exit.void)),
    )
    return managed
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {})
    throw cause
  }
}
