import net from "node:net"
import { existsSync } from "node:fs"
import { unlink } from "node:fs/promises"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  FiberSet,
  Layer,
  Queue,
  Schema,
  Stream,
} from "effect"
import {
  PACKAGE_VERSION,
  MusicSessionConfig,
  type MusicSessionOptions,
} from "./config.ts"
import { NdjsonFramer, encodeFrame } from "./framing.ts"
import {
  baselineCapabilities,
  decodeRequest,
  failure,
  PROTOCOL,
  protocolError,
  requestIdFromUnknown,
  response,
  type ProtocolError,
  type Request,
} from "./protocol.ts"
import {
  MusicSessionCoordinator,
  SessionCommandError,
  layer as coordinatorLayer,
} from "./coordinator.ts"
import type {
  ProviderStatus,
  RevisionedState,
  TransportAction,
} from "./protocol.ts"
import {
  createFakeProvider,
  layer as providerLayer,
  layerFromLegacy,
  type LegacySessionProvider,
} from "./provider.ts"

export class MusicSessionSocketError extends Schema.TaggedErrorClass<MusicSessionSocketError>()(
  "MusicSession.SocketError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const socketError = (operation: string, cause: unknown) =>
  new MusicSessionSocketError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause: { cause },
  })

type Coordinator = {
  readonly daemonInstanceId: string
  readonly status: Stream.Stream<ProviderStatus>
  readonly states: Stream.Stream<RevisionedState>
  readonly current: () => Effect.Effect<RevisionedState>
  readonly submit: (
    action: TransportAction,
    positionMs?: number,
  ) => Effect.Effect<{ readonly action: TransportAction }, SessionCommandError>
}
export type MusicSessionServer = {
  readonly coordinator: Coordinator
  close(): Promise<void>
}

/** Narrow test-only lifecycle seam; production uses no hooks. */
export type ServerLifecycleHooks = {
  /** Inject after real close/unlink cleanup; focused tests can assert order. */
  readonly closeFailure?: () => Error | undefined
  readonly unlinkFailure?: () => NodeJS.ErrnoException | undefined
  readonly onClose?: () => void
  readonly onUnlink?: () => void
  readonly onCleanupFailure?: (error: MusicSessionSocketError) => void
  /** Runs at Node callback entry, before the closing/enrollment decision. */
  readonly onNodeConnection?: (socket: net.Socket) => void
  /** Observes production closing before listener close stops acceptance. */
  readonly onClosing?: () => void
  /** Test-only Effect gate held after closing and before listener close. */
  readonly awaitClosing?: Effect.Effect<void>
  /** Observes a socket refused by the production closing branch. */
  readonly onRefused?: (socket: net.Socket) => void
  /** Test-only synchronous enrollment refusal; production always enrolls. */
  readonly canEnroll?: (socket: net.Socket) => boolean
  readonly onCoordinator?: () => void
  readonly onListener?: (server: net.Server) => void
  readonly onListenerFinalized?: () => void
  readonly onAccepted?: (socket: net.Socket) => void
  readonly onEnrolled?: (socket: net.Socket) => void
  readonly onConnectionFinalized?: () => void
  readonly onInputFinalized?: () => void
  readonly onInputProcessorFinalized?: () => void
  readonly onInputEof?: () => void
  readonly onForwarderStarted?: () => void
  readonly onForwarderFinalized?: () => void
  readonly onConnectionFailure?: (cause: unknown) => void
  readonly onWriteAttempt?: (socket: net.Socket) => void
  readonly onCommandAdmission?: (action: TransportAction) => void
}
const invokeHook = (hook: (() => void) | undefined) => {
  try {
    hook?.()
  } catch {
    // Test observation must never escape a Node callback or alter ownership.
  }
}

export class MusicSessionServerService extends Context.Service<
  MusicSessionServerService,
  {
    readonly coordinator: Coordinator
    /** Scoped server faults are raced by the foreground daemon. */
    readonly awaitFailure: Effect.Effect<never, MusicSessionSocketError>
    /** Synchronous boundary state for outer adapters after scope closure. */
    readonly failure: () => MusicSessionSocketError | undefined
    readonly cleanupFailures: () => ReadonlyArray<MusicSessionSocketError>
    readonly awaitCleanup: Effect.Effect<ReadonlyArray<MusicSessionSocketError>>
    readonly connectionFailureCount: () => number
  }
>()("@naxodev/music-core/MusicSessionServer") {}

const listen = (server: net.Server, socketPath: string) =>
  Effect.sync(() => {
    // Node permits rebinding an existing Unix socket on some platforms. Never
    // replace a path this server did not bind; lifecycle recovery owns stale
    // artifact policy in a later phase.
    if (existsSync(socketPath))
      throw socketError("listen", new Error("socket path is already occupied"))
  }).pipe(
    Effect.mapError((cause) => socketError("listen", cause)),
    Effect.andThen(
      Effect.tryPromise({
        try: (signal) =>
          new Promise<void>((resolve, reject) => {
            let settled = false
            const cleanup = () => {
              signal.removeEventListener("abort", onAbort)
              server.off("error", onError)
              server.off("listening", onListening)
            }
            const settle = (f: () => void) => {
              if (settled) return
              settled = true
              cleanup()
              f()
            }
            const onError = (cause: Error) => settle(() => reject(cause))
            const onListening = () => settle(resolve)
            const onAbort = () =>
              settle(() =>
                reject(new Error("listener acquisition interrupted")),
              )
            signal.addEventListener("abort", onAbort, { once: true })
            server.once("error", onError)
            server.once("listening", onListening)
            try {
              server.listen(socketPath)
            } catch (cause) {
              settle(() => reject(cause))
            }
          }),
        catch: (cause) => socketError("listen", cause),
      }),
    ),
  )

const closeServer = (server: net.Server, hooks: ServerLifecycleHooks) =>
  Effect.tryPromise({
    try: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause ? reject(cause) : resolve())),
      )
      invokeHook(hooks.onClose)
      const injected = hooks.closeFailure?.()
      if (injected) throw injected
    },
    catch: (cause) => socketError("close", cause),
  })

const unlinkOwnedPath = (socketPath: string, hooks: ServerLifecycleHooks) =>
  Effect.tryPromise({
    try: async () => {
      await unlink(socketPath).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause
      })
      invokeHook(hooks.onUnlink)
      const injected = hooks.unlinkFailure?.()
      if (injected?.code !== "ENOENT" && injected) throw injected
    },
    catch: (cause) => socketError("unlink", cause),
  })

const connection = (
  socket: net.Socket,
  coordinator: Coordinator,
  maxFrameBytes: number,
  hooks: ServerLifecycleHooks,
  reportFailure: (cause: unknown) => void,
) =>
  Effect.gen(function* () {
    const endOfInput = Symbol("end-of-input")
    const input = yield* Queue.bounded<Buffer | typeof endOfInput>(64)
    const completion = yield* Queue.unbounded<void>()
    let ended = false
    let closed = false
    const close = () => {
      if (!closed) {
        closed = true
        socket.destroy()
      }
    }
    const onData = (chunk: Buffer) => {
      if (!Queue.offerUnsafe(input, chunk)) close()
    }
    const onEnd = () => {
      ended = true
      // EOF travels through the same serial processor as data, so `end()`
      // cannot inspect the framer before every earlier chunk has been pushed.
      if (!Queue.offerUnsafe(input, endOfInput)) {
        close()
        Queue.offerUnsafe(completion, undefined)
      }
    }
    const onError = (cause: Error) => {
      reportFailure(cause)
      close()
    }
    const onClose = () => {
      close()
      // With allowHalfOpen, EOF completion belongs to the serial processor.
      // Abrupt disconnects still complete the connection immediately.
      if (!ended) Queue.offerUnsafe(completion, undefined)
    }
    const framer = new NdjsonFramer(maxFrameBytes)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        socket.on("data", onData)
        socket.on("end", onEnd)
        socket.on("error", onError)
        socket.on("close", onClose)
      }),
      () =>
        Effect.sync(() => {
          socket.off("data", onData)
          socket.off("end", onEnd)
          socket.off("error", onError)
          socket.off("close", onClose)
          close()
        }).pipe(
          Effect.andThen(Queue.shutdown(input)),
          Effect.andThen(Queue.shutdown(completion)),
          Effect.ensuring(
            Effect.sync(() => {
              invokeHook(hooks.onInputFinalized)
              invokeHook(hooks.onConnectionFinalized)
            }),
          ),
        ),
    )
    let hello = false
    let highestId = -1
    const send = (value: unknown) =>
      Effect.sync(() => {
        if (!closed && !socket.destroyed) {
          invokeHook(() => hooks.onWriteAttempt?.(socket))
          socket.write(encodeFrame(value))
        }
      })
    const reject = (
      request: Request,
      code: Parameters<typeof protocolError>[0],
      message: string,
    ) => send(failure(request.requestId, protocolError(code, message)))
    const process = Effect.fn("MusicSession.Connection.frame")(function* (
      raw: unknown,
    ) {
      let request: Request
      try {
        request = decodeRequest(raw)
      } catch (cause) {
        const requestId = requestIdFromUnknown(raw)
        if (requestId === undefined) return close()
        if (requestId <= highestId)
          return yield* send(
            failure(
              requestId,
              protocolError(
                "DUPLICATE_REQUEST_ID",
                "request IDs must strictly increase",
              ),
            ),
          )
        highestId = requestId
        const candidate = cause as Partial<ProtocolError>
        return yield* send(
          failure(
            requestId,
            typeof candidate.code === "string" &&
              typeof candidate.message === "string"
              ? protocolError(
                  candidate.code as ProtocolError["code"],
                  candidate.message,
                  candidate.retryable,
                )
              : protocolError("INVALID_REQUEST", "invalid request"),
          ),
        )
      }
      if (request.requestId <= highestId)
        return yield* reject(
          request,
          "DUPLICATE_REQUEST_ID",
          "request IDs must strictly increase",
        )
      highestId = request.requestId
      if (!hello) {
        if (request.type !== "hello") {
          yield* reject(request, "INVALID_REQUEST", "hello is required first")
          return close()
        }
        if (request.protocol.major !== PROTOCOL.major) {
          yield* reject(
            request,
            "INCOMPATIBLE_PROTOCOL",
            `protocol major ${PROTOCOL.major} is required`,
          )
          return close()
        }
        if (
          !baselineCapabilities.every((capability) =>
            request.capabilities.includes(capability),
          )
        ) {
          yield* reject(
            request,
            "UNSUPPORTED_CAPABILITY",
            "peer is missing baseline capabilities",
          )
          return close()
        }
        hello = true
        yield* send(
          response(request.requestId, {
            daemonInstanceId: coordinator.daemonInstanceId,
            packageVersion: PACKAGE_VERSION,
            protocol: PROTOCOL,
            capabilities: baselineCapabilities.filter((capability) =>
              request.capabilities.includes(capability),
            ),
          }),
        )
        yield* Effect.sync(() => invokeHook(hooks.onForwarderStarted))
        yield* coordinator.status.pipe(
          Stream.runForEach((status) => send({ type: "status", status })),
          Effect.ensuring(
            Effect.sync(() => invokeHook(hooks.onForwarderFinalized)),
          ),
          Effect.forkScoped,
        )
        yield* Effect.sync(() => invokeHook(hooks.onForwarderStarted))
        yield* coordinator.states.pipe(
          Stream.runForEach((snapshot) => send({ type: "state", snapshot })),
          Effect.ensuring(
            Effect.sync(() => invokeHook(hooks.onForwarderFinalized)),
          ),
          Effect.forkScoped,
        )
        return
      }
      if (request.type === "state")
        return yield* coordinator
          .current()
          .pipe(
            Effect.flatMap((state) => send(response(request.requestId, state))),
          )
      if (request.type === "hello")
        return yield* reject(
          request,
          "INVALID_REQUEST",
          "hello was already completed",
        )
      yield* Effect.sync(() =>
        invokeHook(() => hooks.onCommandAdmission?.(request.action)),
      )
      return yield* coordinator.submit(request.action, request.positionMs).pipe(
        Effect.matchEffect({
          onSuccess: (result) => send(response(request.requestId, result)),
          onFailure: (error) =>
            send(
              failure(
                request.requestId,
                protocolError(error.code, error.message),
              ),
            ),
        }),
      )
    })
    yield* Effect.forever(
      Queue.take(input).pipe(
        Effect.flatMap((chunk) =>
          chunk === endOfInput
            ? Effect.sync(() => {
                try {
                  framer.end()
                } catch {
                  // EOF framing errors are local to this connection.
                }
                invokeHook(hooks.onInputEof)
                close()
                Queue.offerUnsafe(completion, undefined)
              })
            : Effect.try({
                try: () => framer.push(chunk),
                catch: () => {
                  close()
                  return [] as unknown[]
                },
              }).pipe(
                Effect.flatMap((frames) =>
                  Effect.forEach(frames, process, { discard: true }),
                ),
              ),
        ),
      ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => invokeHook(hooks.onInputProcessorFinalized)),
      ),
      Effect.forkScoped,
    )
    // EOF completes only after the serial processor has consumed every queued
    // chunk and validated the framer; abrupt close completes immediately.
    yield* Queue.take(completion)
  })

/** Scoped Unix listener. Accepted sockets enter a server-owned FiberSet. */
const makeLayer = (hooks: ServerLifecycleHooks = {}) =>
  Layer.effect(
    MusicSessionServerService,
    Effect.gen(function* () {
      const config = (yield* MusicSessionConfig).options
      const coordinator = yield* MusicSessionCoordinator
      invokeHook(hooks.onCoordinator)
      const connections = yield* FiberSet.make<void, never>()
      const runConnection = yield* FiberSet.runtime(connections)()
      // Keep a bounded synchronous diagnostic metric: every locally-contained
      // connection defect increments it before the connection is isolated.
      let connectionFailureCount = 0
      const sockets = new Set<net.Socket>()
      const reportFailure = (cause: unknown) => {
        connectionFailureCount += 1
        invokeHook(() => hooks.onConnectionFailure?.(cause))
      }
      let closing = false
      const canEnroll = (socket: net.Socket) => {
        try {
          return hooks.canEnroll?.(socket) !== false
        } catch {
          // A test seam cannot strand an accepted Node socket.
          return false
        }
      }
      const onConnection = (socket: net.Socket) => {
        invokeHook(() => hooks.onNodeConnection?.(socket))
        if (closing) {
          invokeHook(() => hooks.onRefused?.(socket))
          socket.destroy()
          return
        }
        if (!canEnroll(socket)) {
          socket.destroy()
          return
        }
        invokeHook(() => hooks.onAccepted?.(socket))
        sockets.add(socket)
        const onClose = () => sockets.delete(socket)
        socket.once("close", onClose)
        invokeHook(() => hooks.onEnrolled?.(socket))
        runConnection(
          Effect.scoped(
            connection(
              socket,
              coordinator,
              config.maxFrameBytes,
              hooks,
              reportFailure,
            ),
          ).pipe(
            // Preserve ordinary shutdown interruption. Genuine local failures
            // are counted and coalesced for diagnostics before containment.
            Effect.tapCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.sync(() => {
                    reportFailure(cause)
                  }).pipe(
                    Effect.andThen(
                      Effect.logWarning("music-session connection failed"),
                    ),
                  ),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.void,
            ),
          ),
        )
      }
      const server = yield* Effect.try({
        // Keep the writable half open through EOF so the scoped input fiber
        // serializes queued data and framer.end() before it owns destruction.
        try: () => net.createServer({ allowHalfOpen: true }, onConnection),
        catch: (cause) => socketError("create", cause),
      })
      invokeHook(() => hooks.onListener?.(server))
      const serverFaults = yield* Queue.unbounded<MusicSessionSocketError>()
      let serverFailure: MusicSessionSocketError | undefined
      const cleanupFailures: MusicSessionSocketError[] = []
      const cleanupComplete =
        Deferred.makeUnsafe<ReadonlyArray<MusicSessionSocketError>>()
      const onServerError = (cause: Error) => {
        serverFailure ??= socketError("server", cause)
        Queue.offerUnsafe(serverFaults, serverFailure)
      }
      // The daemon races this scoped effect with its signal wait, so a post-bind
      // EventEmitter error reaches the same typed lifetime boundary as startup.
      const awaitFailure = Queue.take(serverFaults).pipe(
        Effect.flatMap((error) => Effect.fail(error)),
      )
      const cleanupPartial = Effect.gen(function* () {
        yield* Effect.sync(() => server.off("error", onServerError))
        yield* closeServer(server, hooks).pipe(Effect.ignore)
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => server.on("error", onServerError)).pipe(
          Effect.andThen(listen(server, config.socketPath)),
          Effect.onError(() => cleanupPartial),
        ),
        () =>
          Effect.gen(function* () {
            closing = true
            yield* Effect.sync(() => {
              invokeHook(hooks.onClosing)
              for (const socket of sockets) socket.destroy()
            })
            // A focused test can hold this finalizer while the real listener
            // remains live, then connect through Node's production callback.
            yield* hooks.awaitClosing ?? Effect.void
            yield* Queue.shutdown(serverFaults)
            // Interrupt and await connection scopes before listener teardown.
            yield* FiberSet.clear(connections)
            yield* FiberSet.awaitEmpty(connections)
            yield* Effect.sync(() => server.off("error", onServerError))
            const capture = <A>(
              effect: Effect.Effect<A, MusicSessionSocketError>,
            ) =>
              Effect.match(effect, {
                onSuccess: () => undefined,
                onFailure: (error) => error,
              })
            const closed = yield* capture(closeServer(server, hooks))
            invokeHook(hooks.onListenerFinalized)
            const unlinked = yield* capture(
              unlinkOwnedPath(config.socketPath, hooks),
            )
            // Finalizers cannot fail typed in Effect v4. Retain every tagged
            // cleanup outcome for outer boundaries after all cleanup completes.
            if (closed) {
              cleanupFailures.push(closed)
              invokeHook(() => hooks.onCleanupFailure?.(closed))
            }
            if (unlinked) {
              cleanupFailures.push(unlinked)
              invokeHook(() => hooks.onCleanupFailure?.(unlinked))
            }
            serverFailure ??= cleanupFailures[0]
            if (cleanupFailures.length > 1)
              yield* Effect.logWarning(cleanupFailures[1])
            yield* Deferred.succeed(cleanupComplete, cleanupFailures)
          }),
      )
      return MusicSessionServerService.of({
        coordinator,
        awaitFailure,
        failure: () => serverFailure,
        cleanupFailures: () => cleanupFailures,
        awaitCleanup: Deferred.await(cleanupComplete),
        connectionFailureCount: () => connectionFailureCount,
      })
    }),
  )

/** Production server layer; focused tests may use `layerWithHooks` directly. */
export const layer = makeLayer()
export const layerWithHooks = (hooks: ServerLifecycleHooks) => makeLayer(hooks)

/** Compatibility adapter: one scoped graph, with Promise calls only at its edge. */
export async function startMusicSessionServer(
  options: MusicSessionOptions,
  provider?: LegacySessionProvider,
  hooks: ServerLifecycleHooks = {},
): Promise<MusicSessionServer> {
  const { layer: configLayer } = await import("./config.ts")
  const selectedProvider = provider ? layerFromLegacy(provider) : providerLayer
  const coordinatorWithProvider = Layer.provide(
    coordinatorLayer,
    selectedProvider,
  )
  const serverWithCoordinator = Layer.provide(
    layerWithHooks(hooks),
    coordinatorWithProvider,
  )
  const graph = Layer.provide(serverWithCoordinator, configLayer(options))
  const stop = Deferred.makeUnsafe<void>()
  let resolveReady: (server: MusicSessionServer) => void = () => {}
  let rejectReady: (cause: unknown) => void = () => {}
  const ready = new Promise<MusicSessionServer>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let closeOutcome: Promise<void> | undefined
  const lifetime = Effect.scoped(
    Effect.gen(function* () {
      const service = yield* MusicSessionServerService
      resolveReady({
        coordinator: service.coordinator,
        close: () => {
          closeOutcome ??= Effect.runPromise(Deferred.succeed(stop, undefined))
            .then(() => running)
            .then(() => {
              const fault = service.failure()
              if (fault) throw fault
            })
          return closeOutcome
        },
      })
      // A post-bind EventEmitter fault ends this exact scope, so the public
      // facade observes its tagged error through close() rather than leaving a
      // listener fault detached from the graph.
      yield* Effect.raceFirst(Deferred.await(stop), service.awaitFailure)
    }).pipe(Effect.provide(graph)),
  )
  const running = Effect.runPromise(lifetime)
  void running.catch((cause) => rejectReady(cause))
  return ready
}

export { createFakeProvider }
