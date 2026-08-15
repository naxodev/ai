import net from "node:net"
import { PACKAGE_VERSION } from "./config.ts"
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
  constructor(error: ProtocolError) {
    super(error.message)
    this.name = "MusicSessionClientError"
    this.code = error.code
    this.retryable = error.retryable
  }
}
type Pending = {
  resolve: (value: unknown) => void
  reject: (error: MusicSessionClientError) => void
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
  toggle(): Promise<unknown>
  play(): Promise<unknown>
  pause(): Promise<unknown>
  next(): Promise<unknown>
  previous(): Promise<unknown>
  seek(positionMs: number): Promise<unknown>
  dispose(): void
}
class Client implements MusicSessionClient {
  #socket: net.Socket
  #framer: NdjsonFramer
  #nextId = 1
  #pending = new Map<number, Pending>()
  #disposed = false
  #failure: ProtocolError | undefined
  #status: ProviderStatus | undefined
  #state: RevisionedState | undefined
  #statusListeners = new Set<Listener<ProviderStatus>>()
  #stateListeners = new Set<Listener<RevisionedState>>()
  readonly daemonInstanceId: string
  readonly negotiatedCapabilities: string[]
  readonly selectedRevision: number
  constructor(
    socket: net.Socket,
    framer: NdjsonFramer,
    daemonInstanceId: string,
    capabilities: string[],
    selectedRevision: number,
  ) {
    this.#socket = socket
    this.#framer = framer
    this.daemonInstanceId = daemonInstanceId
    this.negotiatedCapabilities = capabilities
    this.selectedRevision = selectedRevision
  }
  get status() {
    return this.#status
  }
  get state() {
    return this.#state
  }
  attach() {
    this.#socket.on("data", (chunk: Buffer) => {
      try {
        for (const frame of this.#framer.push(chunk)) this.receive(frame)
      } catch {
        this.terminate({
          code: "CONNECTION_LOST",
          message: "invalid daemon frame",
          retryable: false,
        })
      }
    })
    this.#socket.on("error", () =>
      this.terminate({
        code: "CONNECTION_LOST",
        message: "connection lost",
        retryable: true,
      }),
    )
    this.#socket.on("close", () =>
      this.terminate({
        code: "INDETERMINATE_COMMAND",
        message: "connection closed before command result",
        retryable: true,
      }),
    )
  }
  receive(raw: unknown) {
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
    if (frame.type === "response") {
      const pending = this.#pending.get(frame.requestId)
      if (!pending) return
      this.#pending.delete(frame.requestId)
      frame.ok
        ? pending.resolve(frame.data)
        : pending.reject(new MusicSessionClientError(frame.error))
      return
    }
    if (frame.type === "status") {
      this.#status = frame.status
      for (const listener of this.#statusListeners)
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
    for (const listener of this.#stateListeners)
      try {
        listener(frame.snapshot)
      } catch {}
  }
  private request(value: Record<string, unknown>): Promise<unknown> {
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
    const requestId = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject })
      this.#socket.write(encodeFrame({ ...value, requestId }), (error) => {
        if (error) {
          this.terminate({
            code: "CONNECTION_LOST",
            message: error.message,
            retryable: true,
          })
        }
      })
    })
  }
  private transport(action: TransportAction, positionMs?: number) {
    return this.request({
      type: "transport",
      action,
      ...(positionMs === undefined ? {} : { positionMs }),
    })
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
    this.#statusListeners.add(listener)
    if (this.#status)
      try {
        listener(this.#status)
      } catch {}
    return () => this.#statusListeners.delete(listener)
  }
  subscribeState(listener: Listener<RevisionedState>) {
    this.#stateListeners.add(listener)
    if (this.#state)
      try {
        listener(this.#state)
      } catch {}
    return () => this.#stateListeners.delete(listener)
  }
  private failAll(error: ProtocolError) {
    for (const pending of this.#pending.values())
      pending.reject(new MusicSessionClientError(error))
    this.#pending.clear()
  }
  private terminate(error: ProtocolError) {
    if (this.#failure || this.#disposed) return
    this.#failure = error
    this.#statusListeners.clear()
    this.#stateListeners.clear()
    this.failAll(error)
    if (!this.#socket.destroyed) this.#socket.destroy()
  }
  dispose() {
    if (this.#disposed) return
    this.#disposed = true
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
    socket.once("connect", resolve)
    socket.once("error", reject)
  }).catch((cause: unknown) => {
    throw new MusicSessionClientError({
      code: "CONNECTION_LOST",
      message: cause instanceof Error ? cause.message : "connection failed",
      retryable: true,
    })
  })
  const framer = new NdjsonFramer(options.maxFrameBytes)
  const handshake = await new Promise<{ hello: unknown; queued: unknown[] }>(
    (resolve, reject) => {
      const queued: unknown[] = []
      let done = false
      const fail = (message: string) => {
        if (!done) {
          done = true
          cleanup()
          socket.destroy()
          reject(
            new MusicSessionClientError({
              code: "CONNECTION_LOST",
              message,
              retryable: true,
            }),
          )
        }
      }
      const onError = () => fail("connection lost during hello")
      const onClose = () => fail("connection closed during hello")
      const onData = (chunk: Buffer) => {
        try {
          for (const raw of framer.push(chunk)) {
            const frame = decodeServerFrame(raw)
            if (!done && frame.type === "response" && frame.requestId === 0) {
              done = true
              if (!frame.ok) {
                cleanup()
                socket.destroy()
                reject(new MusicSessionClientError(frame.error))
                return
              }
              queued.push(...framer.push(""))
              cleanup()
              resolve({ hello: frame.data, queued })
              continue
            }
            if (done) queued.push(raw)
          }
        } catch {
          fail("invalid hello response")
        }
      }
      const cleanup = () => {
        socket.off("error", onError)
        socket.off("close", onClose)
        socket.off("data", onData)
      }
      socket.on("error", onError)
      socket.on("close", onClose)
      socket.on("data", onData)
      socket.write(
        encodeFrame({
          type: "hello",
          requestId: 0,
          protocol: offered,
          packageVersion: options.packageVersion ?? PACKAGE_VERSION,
          clientId: options.clientId,
          hostKind: options.hostKind,
          capabilities,
        }),
      )
    },
  )
  let result: ReturnType<typeof decodeHelloResult>
  try {
    result = decodeHelloResult(handshake.hello)
  } catch {
    socket.destroy()
    throw new MusicSessionClientError({
      code: "INVALID_REQUEST",
      message: "invalid hello result",
      retryable: false,
    })
  }
  if (
    result.protocol.major !== offered.major ||
    result.protocol.selectedRevision < offered.minRevision ||
    result.protocol.selectedRevision > offered.maxRevision ||
    !result.capabilities.includes("state-replay") ||
    result.capabilities.some((capability) => !capabilities.includes(capability))
  ) {
    socket.destroy()
    throw new MusicSessionClientError({
      code: "INVALID_REQUEST",
      message: "impossible negotiated hello result",
      retryable: false,
    })
  }
  const client = new Client(
    socket,
    framer,
    result.daemonInstanceId,
    [...result.capabilities],
    result.protocol.selectedRevision,
  )
  client.attach()
  for (const frame of handshake.queued) client.receive(frame)
  return client
}
