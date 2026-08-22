import net from "node:net"
import { spawn as spawnChild } from "node:child_process"
import { fileURLToPath } from "node:url"
import { basename } from "node:path"
import {
  Cause,
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
  type ArtworkIdentity,
  type ArtworkResult,
  type HostKind,
  type ProtocolError,
  type ProviderStatus,
  type ProtocolRange,
  type RevisionedState,
  type TransportAction,
  type TransportResult,
  decodeTransportResult,
  decodeArtworkIdentity,
  decodeArtworkResult,
} from "./protocol.ts"

export type MusicSessionClientOptions = {
  socketPath: string
  clientId: string
  hostKind: HostKind
  signal?: AbortSignal
  packageVersion?: string
  maxFrameBytes?: number
  protocolRange?: ProtocolRange
  capabilities?: string[]
  /** Local bound for unsettled transport requests on this connection. */
  maxPendingRequests?: number
}

const DEFAULT_MAX_PENDING_REQUESTS = 128
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
type Pending =
  | {
      readonly kind: "transport"
      readonly id: number
      readonly action: TransportAction
      readonly resolve: (value: TransportResult) => void
      readonly reject: (error: MusicSessionClientError) => void
    }
  | {
      readonly kind: "artwork"
      readonly id: number
      readonly resolve: (value: ArtworkResult) => void
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
  artwork(identity: ArtworkIdentity): Promise<ArtworkResult>
  dispose(): void
}
class Client implements MusicSessionClient {
  #socket: net.Socket
  #framer: NdjsonFramer
  #nextId = 1
  #pending = new Map<number, Pending>()
  #maxPendingRequests: number
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
  #handshake:
    | {
        readonly offered: ProtocolRange
        readonly capabilities: string[]
        readonly resolve: () => void
        readonly reject: (error: MusicSessionClientError) => void
      }
    | undefined
  constructor(
    socket: net.Socket,
    framer: NdjsonFramer,
    maxPendingRequests: number,
  ) {
    this.#socket = socket
    this.#framer = framer
    this.#maxPendingRequests = maxPendingRequests
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
        this.terminate({
          code: "CONNECTION_LOST",
          message: "unexpected frame before hello response",
          retryable: false,
        })
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
        handshake.resolve()
      } catch {
        this.terminate({
          code: "CONNECTION_LOST",
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
        if (pending.kind === "artwork")
          this.settleSuccess(pending, decodeArtworkResult(frame.data))
        else {
          const result = decodeTransportResult(frame.data)
          if (result.action !== pending.action)
            throw new Error("transport result action does not match request")
          this.settleSuccess(pending, result)
        }
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
  private settleSuccess(
    pending: Pending,
    result: TransportResult | ArtworkResult,
  ) {
    if (this.#pending.get(pending.id) !== pending) return
    this.#pending.delete(pending.id)
    ;(pending.resolve as (value: TransportResult | ArtworkResult) => void)(
      result,
    )
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
    if (this.#pending.size >= this.#maxPendingRequests)
      return Promise.reject(
        new MusicSessionClientError({
          code: "SERVER_BUSY",
          message: "client pending request limit reached",
          retryable: true,
        }),
      )
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
      const pending: Pending = {
        kind: "transport",
        id: requestId,
        action,
        resolve,
        reject,
      }
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
  artwork(identity: ArtworkIdentity): Promise<ArtworkResult> {
    try {
      identity = decodeArtworkIdentity(identity)
    } catch (cause) {
      return Promise.reject(new MusicSessionClientError(cause as ProtocolError))
    }
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
    if (!this.negotiatedCapabilities.includes("native-artwork"))
      return Promise.reject(
        new MusicSessionClientError({
          code: "UNSUPPORTED_CAPABILITY",
          message: "native-artwork was not negotiated",
          retryable: false,
        }),
      )
    if (this.#pending.size >= this.#maxPendingRequests)
      return Promise.reject(
        new MusicSessionClientError({
          code: "SERVER_BUSY",
          message: "client pending request limit reached",
          retryable: true,
        }),
      )
    if (this.#nextId > Number.MAX_SAFE_INTEGER)
      return Promise.reject(
        new MusicSessionClientError({
          code: "INVALID_REQUEST",
          message: "request ID space exhausted",
          retryable: false,
        }),
      )
    const requestId = this.#nextId++
    return new Promise<ArtworkResult>((resolve, reject) => {
      const pending: Pending = {
        kind: "artwork",
        id: requestId,
        resolve,
        reject,
      }
      this.#pending.set(requestId, pending)
      try {
        this.#socket.write(
          encodeFrame({ type: "artwork", requestId, identity }),
          (error) => {
            if (error)
              this.terminate({
                code: "CONNECTION_LOST",
                message: error.message,
                retryable: true,
              })
          },
        )
      } catch {
        this.terminate({
          code: "CONNECTION_LOST",
          message: "connection write failed",
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
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort)
      const onAbort = () => this.dispose()
      this.#handshake = {
        offered,
        capabilities,
        resolve: () => {
          cleanup()
          resolve()
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.attach()
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
    for (const pending of [...this.#pending.values()])
      if (pending.kind === "artwork")
        this.settleFailure(pending, {
          code: "CONNECTION_LOST",
          message: "connection ended before artwork result",
          retryable: true,
        })
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
    for (const pending of [...this.#pending.values()])
      this.settleFailure(
        pending,
        pending.kind === "artwork"
          ? {
              code: "DISPOSED",
              message: "client is disposed",
              retryable: false,
            }
          : {
              code: "INDETERMINATE_COMMAND",
              message: "client disposed before command result",
              retryable: false,
            },
      )
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
  const maxPendingRequests =
    options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS
  if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests <= 0)
    throw new MusicSessionClientError({
      code: "INVALID_REQUEST",
      message: "maxPendingRequests must be a positive safe integer",
      retryable: false,
    })
  const socket = net.createConnection(options.socketPath)
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", onConnect)
      socket.off("error", onError)
      options.signal?.removeEventListener("abort", onAbort)
    }
    const onConnect = () => {
      cleanup()
      resolve()
    }
    const onError = (cause: Error) => {
      cleanup()
      reject(cause)
    }
    const onAbort = () => {
      cleanup()
      socket.destroy()
      reject(
        new MusicSessionClientError({
          code: "DISPOSED",
          message: "music session connection was interrupted",
          retryable: false,
        }),
      )
    }
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    socket.once("connect", onConnect)
    socket.once("error", onError)
    options.signal?.addEventListener("abort", onAbort, { once: true })
  }).catch((cause: unknown) => {
    socket.destroy()
    if (cause instanceof MusicSessionClientError) throw cause
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
  const client = new Client(
    socket,
    new NdjsonFramer(options.maxFrameBytes),
    maxPendingRequests,
  )
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
    options.signal,
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
 * Performs one managed-runtime inspection and hello. It never starts, signals,
 * or replaces a daemon generation. A retryable reset gets one fresh hello only
 * after the startup marker disappears; persistent unknown peers stay occupied.
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
  const socketPath = probe.socketPath
  if (!socketPath) return nonEndpoint()
  const connect = async (): Promise<MusicSessionDiscovery> => {
    const client = await createMusicSessionClient({
      ...options,
      socketPath,
    })
    const interrupted = () => {
      client.dispose()
      return new MusicSessionClientError({
        code: "DISPOSED",
        message: "music session discovery was interrupted",
        retryable: false,
      })
    }
    const onAbort = () => client.dispose()
    try {
      if (options.signal?.aborted) throw interrupted()
      options.signal?.addEventListener("abort", onAbort, { once: true })
      const found = await probe.healthy(client)
      if (options.signal?.aborted) throw interrupted()
      if (found.type !== "healthy")
        throw new Error("invalid managed runtime healthy probe")
      return found.cleanup
        ? { type: "healthy", client, cleanup: found.cleanup }
        : { type: "healthy", client }
    } catch (cause) {
      client.dispose()
      throw cause
    } finally {
      options.signal?.removeEventListener("abort", onAbort)
    }
  }
  const incompatible = (cause: unknown) =>
    cause instanceof MusicSessionClientError &&
    cause.code === "INCOMPATIBLE_PROTOCOL"
  const refused = (cause: unknown) =>
    cause instanceof MusicSessionClientError &&
    cause.transportCode !== undefined &&
    ["ECONNREFUSED", "ENOENT"].includes(cause.transportCode)
  const retryableReset = (cause: unknown) =>
    cause instanceof MusicSessionClientError &&
    cause.code === "CONNECTION_LOST" &&
    cause.retryable
  const interrupted = (cause: unknown) =>
    options.signal?.aborted ||
    (cause instanceof MusicSessionClientError && cause.code === "DISPOSED")

  try {
    return await connect()
  } catch (cause) {
    if (interrupted(cause)) throw cause
    if (incompatible(cause))
      return { type: "incompatible", error: cause as MusicSessionClientError }
    if (refused(cause)) return nonEndpoint()
    if (retryableReset(cause)) {
      // A live, unchanged marker still owns the pre-hello generation. If the
      // winner released it while this hello was in flight, confirm once against
      // the now-ready owner-only endpoint. This grants no cleanup authority.
      if ((await probe.starting()) === "starting") return { type: "starting" }
      try {
        return await connect()
      } catch (confirmationCause) {
        if (interrupted(confirmationCause)) throw confirmationCause
        if (incompatible(confirmationCause))
          return {
            type: "incompatible",
            error: confirmationCause as MusicSessionClientError,
          }
        // Confirmation never inherits stale-cleanup authority from the first
        // reset. A disappeared or replaced endpoint remains fail-closed.
        if (refused(confirmationCause)) return { type: "occupied" }
      }
    }
    return { type: "occupied" }
  }
}

/** Compatibility spelling for callers that name the operation an endpoint probe. */
export const discoverMusicSessionEndpoint = discoverMusicSession

export class MusicSessionStartupError extends Schema.TaggedError<MusicSessionStartupError>()(
  "MusicSession.StartupError",
  {
    operation: Schema.Union([
      Schema.Literal("spawn"),
      Schema.Literal("exit"),
      Schema.Literal("timeout"),
      Schema.Literal("occupied"),
    ]),
    message: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    signal: Schema.optional(Schema.String),
    diagnostic: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const MAX_DAEMON_DIAGNOSTIC_BYTES = 512

type DaemonStderr = {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown
  off(event: "data", listener: (chunk: Uint8Array) => void): unknown
  unref?(): void
}
type SpawnedDaemon = {
  once(event: "spawn" | "error", listener: (cause?: Error) => void): unknown
  once(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown
  off(event: "spawn" | "error", listener: (cause?: Error) => void): unknown
  off(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown
  readonly stderr: DaemonStderr | null
  unref(): void
}
export type MusicSessionDaemonLaunch = {
  /** The daemon reports readiness only after its real graph has started. */
  ready(): boolean
  /** Retains only a bounded, daemon-prefixed early-exit diagnostic. */
  earlyFailure(): MusicSessionStartupError | undefined
}
export type MusicSessionDaemonLauncher = (
  runtime: MusicSessionRuntimePaths,
) => Promise<void | MusicSessionDaemonLaunch>
type ManagedSpawnOptions = {
  readonly detached: true
  readonly stdio: ["ignore", "ignore", "pipe"]
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
  /** Test-only runtime identity seam for embedded hosts. */
  readonly runtime?: () => string
}
export type MusicSessionRuntimeIdentity = {
  readonly execPath: string
  readonly release: { readonly name?: string } | undefined
  readonly versions: { readonly bun?: string }
}
/** Select Node only when the embedding executable is not a verified JS runner. */
export const resolveMusicSessionDaemonRuntime = (
  identity: MusicSessionRuntimeIdentity = process,
) =>
  identity.release?.name === "node" &&
  (identity.versions.bun === undefined || basename(identity.execPath) === "bun")
    ? identity.execPath
    : "node"
const productionLauncherDependencies: MusicSessionDaemonLauncherDependencies = {
  entry: () =>
    fileURLToPath(new URL("../dist/music-sessiond.js", import.meta.url)),
  spawn: (command, args, options) => spawnChild(command, args, options),
}

/** Narrow process boundary; the managed daemon receives no socket override. */
export const launchManagedMusicSessionDaemon = async (
  _runtime: MusicSessionRuntimePaths,
  dependencies: MusicSessionDaemonLauncherDependencies = productionLauncherDependencies,
): Promise<MusicSessionDaemonLaunch> => {
  let child: SpawnedDaemon
  try {
    child = dependencies.spawn(
      dependencies.runtime?.() ?? resolveMusicSessionDaemonRuntime(),
      [dependencies.entry()],
      {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        shell: false,
        env: { PATH: process.env.PATH ?? "" },
      },
    )
  } catch (cause) {
    throw new MusicSessionStartupError({
      operation: "spawn",
      message: "unable to spawn music session daemon",
      cause,
    })
  }
  let earlyFailure: MusicSessionStartupError | undefined
  let ready = false
  let diagnostic = Buffer.alloc(0)
  let lineKind: "prefix" | "ready" | "diagnostic" | "other" = "prefix"
  let linePrefix = Buffer.alloc(0)
  let diagnosticLine = Buffer.alloc(0)
  const readyPrefix = Buffer.from("music-sessiond listening on ")
  const diagnosticPrefix = Buffer.from("music-sessiond:")
  const appendDiagnostic = (line: Buffer) => {
    if (diagnostic.length >= MAX_DAEMON_DIAGNOSTIC_BYTES) return
    const separator =
      diagnostic.length === 0 ? Buffer.alloc(0) : Buffer.from("\n")
    const available = MAX_DAEMON_DIAGNOSTIC_BYTES - diagnostic.length
    diagnostic = Buffer.concat([diagnostic, separator, line]).subarray(
      0,
      available + diagnostic.length,
    )
  }
  const decodedDiagnostic = () => {
    // A byte cap can end in the middle of UTF-8. Decode only a prefix whose
    // re-encoded form remains within the host-visible byte budget.
    for (let end = diagnostic.length; end >= 0; end--) {
      const text = diagnostic.subarray(0, end).toString("utf8").trimEnd()
      if (Buffer.byteLength(text, "utf8") <= MAX_DAEMON_DIAGNOSTIC_BYTES)
        return text
    }
    return ""
  }
  const resetLine = () => {
    lineKind = "prefix"
    linePrefix = Buffer.alloc(0)
    diagnosticLine = Buffer.alloc(0)
  }
  const finishLine = () => {
    if (lineKind === "ready") {
      ready = true
      releaseCapture()
    } else if (lineKind === "diagnostic") {
      const line =
        diagnosticLine[diagnosticLine.length - 1] === 0x0d
          ? diagnosticLine.subarray(0, -1)
          : diagnosticLine
      appendDiagnostic(line)
    }
    resetLine()
  }
  const receiveByte = (byte: number) => {
    if (byte === 0x0a) {
      finishLine()
      return
    }
    if (lineKind === "diagnostic") {
      if (diagnosticLine.length < MAX_DAEMON_DIAGNOSTIC_BYTES)
        diagnosticLine = Buffer.concat([diagnosticLine, Buffer.of(byte)])
      return
    }
    if (lineKind !== "prefix") return
    linePrefix = Buffer.concat([linePrefix, Buffer.of(byte)])
    if (readyPrefix.subarray(0, linePrefix.length).equals(linePrefix)) {
      if (linePrefix.length === readyPrefix.length) lineKind = "ready"
      return
    }
    if (diagnosticPrefix.subarray(0, linePrefix.length).equals(linePrefix)) {
      if (linePrefix.length === diagnosticPrefix.length) {
        lineKind = "diagnostic"
        diagnosticLine = linePrefix
      }
      return
    }
    lineKind = "other"
  }
  const onStderr = (chunk: Uint8Array) => {
    for (const byte of chunk) {
      receiveByte(byte)
      if (ready) return
    }
  }
  const releaseCapture = () => {
    child.stderr?.off("data", onStderr)
    child.off("exit", exited)
  }
  child.stderr?.on("data", onStderr)
  child.stderr?.unref?.()
  const exited = (code: number | null, signal: string | null) => {
    if (ready) return
    if (lineKind === "diagnostic") appendDiagnostic(diagnosticLine)
    resetLine()
    earlyFailure ??= new MusicSessionStartupError({
      operation: "exit",
      message: "music session daemon exited before endpoint readiness",
      ...(code === null ? {} : { exitCode: code }),
      ...(signal === null ? {} : { signal }),
      ...(diagnostic.length > 0 ? { diagnostic: decodedDiagnostic() } : {}),
    })
    releaseCapture()
  }
  child.once("exit", exited)
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
      child.off("exit", exited)
      child.stderr?.off("data", onStderr)
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
  return { ready: () => ready, earlyFailure: () => earlyFailure }
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
  const promise = <A>(run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      // Boundaries that consume the signal stop immediately. A test seam may
      // ignore it and return a late client, which still needs explicit disposal.
      try: (signal) =>
        run(signal).then((value) => {
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
    const { attempts, initialDelayMs, maxDelayMs, handshakeTimeoutMs } =
      yield* resolveMusicSessionStartup(options.startup)
    const lease = yield* Ref.make<StartupMarkerLease | undefined>(undefined)
    const launched = yield* Ref.make<MusicSessionDaemonLaunch | undefined>(
      undefined,
    )
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
      const launch = yield* Ref.get(launched)
      const earlyFailure = launch?.earlyFailure()
      if (earlyFailure) return yield* Effect.fail(earlyFailure)
      // A daemon-owned readiness line closes the listener/hello window. Test
      // launchers that return void retain the historical immediate probe seam.
      if (launch && !launch.ready())
        return yield* Effect.fail(new StartupPending())
      const discovery = yield* promise((signal) =>
        discover({
          ...options,
          runtime,
          signal,
          ...(ownedLease ? { ownedLease } : {}),
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(handshakeTimeoutMs),
          orElse: () =>
            Effect.fail(
              new MusicSessionStartupError({
                operation: "occupied",
                message:
                  "music session endpoint did not complete hello before the startup attempt deadline",
              }),
            ),
        }),
      )
      // If the child died while the probe was in flight, preserve its causal
      // startup error rather than translating the probe's peer result.
      const failureAfterDiscovery = launch?.earlyFailure()
      if (failureAfterDiscovery)
        return yield* Effect.fail(failureAfterDiscovery)
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
      if (discovery.type === "occupied") {
        return yield* Effect.fail(
          new MusicSessionStartupError({
            operation: "occupied",
            message:
              "music session endpoint is occupied by an unclassifiable peer",
          }),
        )
      }
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
          const nextLaunch = yield* promise(() => launcher(runtime))
          if (nextLaunch) yield* Ref.set(launched, nextLaunch)
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
  Effect.runPromise(connectOrStartMusicSessionEffect(options), {
    signal: options.signal,
  })

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
  artwork(identity: ArtworkIdentity): Promise<ArtworkResult>
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
    for (const unsubscribe of [
      active.unsubscribeStatus,
      active.unsubscribeState,
      active.unsubscribeTerminal,
    ]) {
      try {
        unsubscribe()
      } catch {}
    }
    if (dispose)
      try {
        active.client.dispose()
      } catch {}
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
  artwork(identity: ArtworkIdentity) {
    const active = this.#active
    if (!active) return Promise.reject(this.#unavailable())
    // Artwork is explicitly non-replayable. A generation that resolves after
    // replacement/disposal must not leak bytes or success into its successor.
    return active.client.artwork(identity).then(
      (result) => {
        if (this.#isCurrent(active.token)) return result
        throw this.#unavailable()
      },
      (error) => {
        if (this.#isCurrent(active.token)) throw error
        throw this.#unavailable()
      },
    )
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
          readonly active: ActiveGeneration | undefined
          readonly pending: MusicSessionClient | undefined
          readonly listeners: Listener<MusicSessionConnectionLifecycle>[]
        }
    >((current) => {
      if (current.disposed || current.terminal)
        return [{ changed: false as const, listeners: [] }, current]
      return [
        {
          changed: true as const,
          active: current.active,
          pending: current.pending,
          listeners: [...current.connectionListeners],
        },
        {
          ...current,
          active: undefined,
          pending: undefined,
          terminal: error,
          lifecycle: { type: "terminal", error },
        },
      ]
    })
    if (!transition.changed) return
    this.#release(transition.active, true)
    try {
      transition.pending?.dispose()
    } catch {}
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
    }).pipe(
      // This supervisor is scoped background work. Convert defects into the
      // Promise-facing terminal state so acquisition and retained listeners
      // cannot wait forever on a child fiber that has already died.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.sync(() =>
            managed.#finish(asManagedTerminal(Cause.squash(cause))),
          ),
      ),
    )
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
      { signal: options.signal },
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
