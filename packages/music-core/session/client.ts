import net from "node:net"
import {
  PACKAGE_VERSION,
  inspectManagedRuntimeForDiscovery,
  resolveMusicSessionRuntimePaths,
  type MusicSessionRuntimePaths,
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
}
export type MusicSessionDiscovery =
  | { readonly type: "healthy"; readonly client: MusicSessionClient }
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
  const probe = await inspectManagedRuntimeForDiscovery(runtime)
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
    return { type: "healthy", client }
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
