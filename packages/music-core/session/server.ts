import net from "node:net"
import type { Stats } from "node:fs"
import { randomUUID } from "node:crypto"
import { chmod, link, lstat, open, readFile, unlink } from "node:fs/promises"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  MusicSessionConfig,
  prepareManagedRuntimeDirectory,
  type MusicSessionOptions,
} from "./config.ts"
import { NdjsonFramer, encodeFrame } from "./framing.ts"
import {
  baselineCapabilities,
  decodeRequestEffect,
  failure,
  helloResult,
  negotiateHello,
  protocolError,
  protocolErrorFromUnknown,
  PROTOCOL,
  requestIdFromUnknown,
  response,
  type NegotiatedSession,
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
  SessionProvider,
  type LegacySessionProvider,
} from "./provider.ts"

export class MusicSessionSocketError extends Schema.TaggedErrorClass<MusicSessionSocketError>()(
  "MusicSession.SocketError",
  {
    operation: Schema.String,
    path: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const socketError = (operation: string, cause: unknown) => {
  const path =
    typeof cause === "object" &&
    cause !== null &&
    "path" in cause &&
    typeof cause.path === "string"
      ? cause.path
      : undefined
  return new MusicSessionSocketError({
    operation,
    ...(path ? { path } : {}),
    message: cause instanceof Error ? cause.message : String(cause),
    cause: { cause },
  })
}

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
  /** Observes completion of the server-owned coordinator child scope. */
  readonly onCoordinatorScopeFinalized?: () => void
  /** Observes completion of the server-owned provider child scope. */
  readonly onProviderScopeFinalized?: () => void
  /** Runs after partial identity capture and before socket hardening. */
  readonly onPartialBound?: (identity: BoundPathIdentity) => void
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
  Effect.tryPromise({
    try: async () => {
      try {
        await lstat(socketPath)
        throw new Error("socket path is already occupied")
      } catch (cause: unknown) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return
        if (
          cause instanceof Error &&
          cause.message === "socket path is already occupied"
        )
          throw cause
        throw cause
      }
    },
    catch: (cause) => socketError("listen", cause),
  }).pipe(
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

type BoundPathIdentity = {
  readonly dev: number
  readonly ino: number
  readonly uid: number
}

type PathStat = Stats

type BindLock = {
  readonly path: string
  readonly handle: Awaited<ReturnType<typeof open>>
  readonly identity: BoundPathIdentity
}

const bindLockIdentity = (stat: PathStat) =>
  ({
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
  }) satisfies BoundPathIdentity

const sameBindLockIdentity = (stat: PathStat, identity: BoundPathIdentity) =>
  stat.isFile() &&
  stat.dev === identity.dev &&
  stat.ino === identity.ino &&
  stat.uid === identity.uid

const unlinkExactBindLock = async (
  path: string,
  identity: BoundPathIdentity,
) => {
  let stat: PathStat
  try {
    stat = await lstat(path)
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    )
      return
    throw cause
  }
  if (!sameBindLockIdentity(stat, identity))
    throw new Error("bind reservation changed before cleanup")
  await unlink(path)
}

const validBindLock = (stat: PathStat, uid: number) =>
  stat.isFile() && stat.uid === uid && (stat.mode & 0o777) === 0o600

const reclaimDeadBindLock = async (path: string) => {
  const uid = process.getuid?.()
  const stat = await lstat(path)
  if (typeof uid !== "number" || !validBindLock(stat, uid))
    throw new Error("bind reservation is not an owner-only regular file")
  if (stat.size > 256) throw new Error("bind reservation is too large")
  let payload: unknown
  try {
    payload = JSON.parse(await readFile(path, "utf8"))
  } catch {
    throw new Error("bind reservation is malformed")
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !(
      "version" in payload &&
      "uid" in payload &&
      "pid" in payload &&
      payload.version === 1 &&
      payload.uid === uid &&
      typeof payload.pid === "number" &&
      Number.isSafeInteger(payload.pid) &&
      payload.pid > 0
    )
  )
    throw new Error("bind reservation is malformed")
  try {
    process.kill(payload.pid, 0)
    return false
  } catch (cause: unknown) {
    if (
      typeof cause !== "object" ||
      cause === null ||
      !("code" in cause) ||
      cause.code !== "ESRCH"
    )
      return false
  }
  await unlinkExactBindLock(path, bindLockIdentity(stat))
  return true
}

// Bun's Node-compatible Unix listener can accept simultaneous `listen` calls
// for one missing pathname. `link` publishes a fully written reservation, so
// a crash before publication leaves only an inert private temporary file.
const acquireBindLock = (socketPath: string) =>
  Effect.tryPromise({
    try: async () => {
      const path = `${socketPath}.bind-lock`
      for (let attempt = 0; attempt < 2; attempt++) {
        const temporaryPath = `${path}.${randomUUID()}.tmp`
        const handle = await open(temporaryPath, "wx", 0o600)
        const stat = await handle.stat()
        const identity = bindLockIdentity(stat)
        let published = false
        try {
          const uid = process.getuid?.()
          if (typeof uid !== "number" || !validBindLock(stat, uid))
            throw new Error(
              "bind reservation is not an owner-only regular file",
            )
          await handle.writeFile(
            JSON.stringify({ version: 1, uid, pid: process.pid }),
          )
          await handle.sync()
          try {
            await link(temporaryPath, path)
            published = true
          } catch (cause: unknown) {
            if (
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "EEXIST" &&
              (await reclaimDeadBindLock(path))
            ) {
              await handle.close().catch(() => {})
              await unlinkExactBindLock(temporaryPath, identity).catch(() => {})
              continue
            }
            throw cause
          }
          await unlinkExactBindLock(temporaryPath, identity)
          return { path, handle, identity } satisfies BindLock
        } catch (cause) {
          await handle.close().catch(() => {})
          if (published)
            await unlinkExactBindLock(path, identity).catch(() => {})
          await unlinkExactBindLock(temporaryPath, identity).catch(() => {})
          throw cause
        }
      }
      throw new Error(
        "bind reservation remained contested after stale recovery",
      )
    },
    catch: (cause) => socketError("listen", cause),
  })

const releaseBindLock = (lock: BindLock | undefined) =>
  Effect.tryPromise({
    try: async () => {
      if (!lock) return
      await lock.handle.close()
      await unlinkExactBindLock(lock.path, lock.identity)
    },
    catch: (cause) => socketError("unlink", cause),
  })

const captureBoundPath = (
  socketPath: string,
  onPartialBound?: (identity: BoundPathIdentity) => void,
) =>
  Effect.tryPromise({
    try: async () => {
      const before = await lstat(socketPath)
      const uid = process.getuid?.()
      if (!before.isSocket() || typeof uid !== "number" || before.uid !== uid)
        throw new Error("bound path is not a same-user Unix socket")
      const identity = {
        dev: before.dev,
        ino: before.ino,
        uid: before.uid,
      } satisfies BoundPathIdentity
      onPartialBound?.(identity)
      await chmod(socketPath, 0o600)
      const stat = await lstat(socketPath)
      if (
        !stat.isSocket() ||
        stat.dev !== identity.dev ||
        stat.ino !== identity.ino ||
        stat.uid !== identity.uid ||
        (stat.mode & 0o777) !== 0o600
      )
        throw new Error("bound socket changed or permissions are not 0600")
      return identity
    },
    catch: (cause) => socketError("harden", cause),
  })

const unlinkOwnedPath = (
  socketPath: string,
  bound: BoundPathIdentity | undefined,
  hooks: ServerLifecycleHooks,
) =>
  Effect.tryPromise({
    try: async () => {
      if (!bound) return
      let stat
      try {
        stat = await lstat(socketPath)
      } catch (cause: unknown) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return
        throw cause
      }
      if (
        !stat.isSocket() ||
        stat.dev !== bound.dev ||
        stat.ino !== bound.ino ||
        stat.uid !== bound.uid
      )
        throw new Error("bound socket path changed before cleanup")
      await unlink(socketPath)
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
    let session: NegotiatedSession | undefined
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
      const decoded = yield* Effect.match(decodeRequestEffect(raw), {
        onFailure: (cause) => ({ ok: false as const, cause }),
        onSuccess: (request) => ({ ok: true as const, request }),
      })
      if (!decoded.ok) {
        const cause = decoded.cause
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
        return yield* send(
          failure(
            requestId,
            protocolErrorFromUnknown(cause) ??
              protocolError("INVALID_REQUEST", "invalid request"),
          ),
        )
      }
      const request: Request = decoded.request
      if (request.requestId <= highestId)
        return yield* reject(
          request,
          "DUPLICATE_REQUEST_ID",
          "request IDs must strictly increase",
        )
      highestId = request.requestId
      if (!session) {
        if (request.type !== "hello") {
          yield* reject(request, "INVALID_REQUEST", "hello is required first")
          return close()
        }
        const negotiated = negotiateHello(
          request,
          PROTOCOL,
          baselineCapabilities,
        )
        if ("code" in negotiated) {
          yield* send(failure(request.requestId, negotiated))
          if (negotiated.code === "INCOMPATIBLE_PROTOCOL")
            return yield* Effect.sync(() => socket.end())
          return
        }
        session = negotiated
        yield* send(
          response(
            request.requestId,
            helloResult(coordinator.daemonInstanceId, session),
          ),
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
      if (!session.capabilities.includes("transport"))
        return yield* reject(
          request,
          "UNSUPPORTED_CAPABILITY",
          "transport capability was not negotiated",
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
const makeLayer = (
  hooks: ServerLifecycleHooks = {},
  selectedProvider = providerLayer,
) =>
  Layer.effect(
    MusicSessionServerService,
    Effect.gen(function* () {
      const configService = yield* MusicSessionConfig
      const config = configService.options
      // These remain unassigned until the listener has bound and hardened.
      // Provider and coordinator ownership are deliberately built below that
      // acquisition point, in distinct child scopes.
      let coordinator: Coordinator
      let closeCoordinator: Effect.Effect<void> = Effect.void
      let closeProvider: Effect.Effect<void> = Effect.void
      let active = false
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
        // Binding precedes coordinator construction. Refuse the tiny interval
        // before the real application handler becomes active.
        if (!active) {
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
      let boundPath: BoundPathIdentity | undefined
      let partialBoundPath: BoundPathIdentity | undefined
      let bindLock: BindLock | undefined
      const cleanupPartial = Effect.gen(function* () {
        yield* Effect.sync(() => server.off("error", onServerError))
        yield* closeServer(server, hooks).pipe(Effect.ignore)
        yield* unlinkOwnedPath(config.socketPath, partialBoundPath, hooks).pipe(
          Effect.ignore,
        )
        yield* releaseBindLock(bindLock).pipe(Effect.ignore)
      })
      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          yield* Effect.sync(() => server.on("error", onServerError))
          if (config.runtime)
            yield* prepareManagedRuntimeDirectory(config.runtime).pipe(
              Effect.mapError((cause) => socketError("prepare", cause)),
            )
          bindLock = yield* acquireBindLock(config.socketPath)
          yield* listen(server, config.socketPath)
          boundPath = yield* captureBoundPath(config.socketPath, (identity) => {
            partialBoundPath = identity
            hooks.onPartialBound?.(identity)
          })
          // The fully hardened socket is now singleton authority. Releasing
          // the acquisition reservation lets later contenders observe the
          // bound path rather than making the sidecar long-lived authority.
          yield* releaseBindLock(bindLock)
          bindLock = undefined
        }).pipe(Effect.onError(() => cleanupPartial)),

        () =>
          Effect.gen(function* () {
            // Stop application acceptance before any asynchronous teardown.
            active = false
            closing = true
            yield* Effect.sync(() => {
              invokeHook(hooks.onClosing)
              for (const socket of sockets) socket.destroy()
            })
            // A focused test can hold this finalizer while the real listener
            // remains live, then connect through Node's production callback.
            yield* hooks.awaitClosing ?? Effect.void
            // Coordinator-owned work may be blocking a connection command.
            // Close it before joining that connection, breaking the cycle.
            yield* closeCoordinator.pipe(Effect.ignore)
            invokeHook(hooks.onCoordinatorScopeFinalized)
            yield* FiberSet.clear(connections)
            yield* FiberSet.awaitEmpty(connections)
            // The provider remains alive while its coordinator and all of its
            // borrowing connection children unwind.
            yield* closeProvider.pipe(Effect.ignore)
            invokeHook(hooks.onProviderScopeFinalized)
            yield* Queue.shutdown(serverFaults)
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
              unlinkOwnedPath(config.socketPath, boundPath, hooks),
            )
            const lockReleased = yield* capture(releaseBindLock(bindLock))
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
            if (lockReleased) {
              cleanupFailures.push(lockReleased)
              invokeHook(() => hooks.onCleanupFailure?.(lockReleased))
            }
            serverFailure ??= cleanupFailures[0]
            if (cleanupFailures.length > 1)
              yield* Effect.logWarning(cleanupFailures[1])
            yield* Deferred.succeed(cleanupComplete, cleanupFailures)
          }),
      )
      // Building these scoped graphs here, rather than declaring them as Layer
      // dependencies, gates their ownership on successful bind. The provider
      // is built once and explicitly loaned to the coordinator child scope.
      const providerScope = yield* Scope.make()
      closeProvider = Scope.close(providerScope, Exit.void)
      const providerServices = yield* Scope.provide(providerScope)(
        Layer.build(selectedProvider),
      )
      const provider = Context.get(providerServices, SessionProvider)
      const coordinatorScope = yield* Scope.make()
      closeCoordinator = Scope.close(coordinatorScope, Exit.void)
      // Start the selected event source in the coordinator scope before
      // activation. `startImmediately` runs the first pull through source
      // acquisition (and thus the provider subscription) before this effect
      // can return. The coordinator consumes that exact first pull, so this
      // readiness boundary neither loses an event nor creates a second source.
      const eventsPull = yield* Scope.provide(coordinatorScope)(
        Stream.toPull(provider.events),
      )
      const firstEventPull = yield* Effect.forkIn(coordinatorScope, {
        startImmediately: true,
      })(eventsPull)
      yield* Effect.yieldNow
      let firstEventPullPending = true
      const coordinatorEvents = Stream.fromPull(
        Effect.sync(() => {
          if (firstEventPullPending) {
            firstEventPullPending = false
            return Fiber.join(firstEventPull)
          }
          return eventsPull
        }),
      )
      const coordinatorProvider = SessionProvider.of({
        ...provider,
        events: coordinatorEvents,
      })
      const coordinatorServices = yield* Scope.provide(coordinatorScope)(
        Layer.build(
          Layer.provide(
            coordinatorLayer,
            Layer.merge(
              Layer.succeed(SessionProvider, coordinatorProvider),
              Layer.succeed(MusicSessionConfig, configService),
            ),
          ),
        ),
      )
      coordinator = Context.get(coordinatorServices, MusicSessionCoordinator)
      active = true
      invokeHook(hooks.onCoordinator)
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
export const layerWithHooks = (
  hooks: ServerLifecycleHooks,
  selectedProvider = providerLayer,
) => makeLayer(hooks, selectedProvider)

/** Compatibility adapter: one scoped graph, with Promise calls only at its edge. */
export async function startMusicSessionServer(
  options: MusicSessionOptions,
  provider?: LegacySessionProvider,
  hooks: ServerLifecycleHooks = {},
): Promise<MusicSessionServer> {
  const { layer: configLayer } = await import("./config.ts")
  const selectedProvider = provider ? layerFromLegacy(provider) : providerLayer
  const graph = Layer.provide(
    layerWithHooks(hooks, selectedProvider),
    configLayer(options),
  )
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
