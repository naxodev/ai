import net from "node:net"
import { unlink } from "node:fs/promises"
import {
  Context,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Queue,
  Schema,
  Scope,
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
export class MusicSessionServerService extends Context.Service<
  MusicSessionServerService,
  { readonly coordinator: Coordinator }
>()("@naxodev/music-core/MusicSessionServer") {}

const listen = (server: net.Server, socketPath: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(socketPath, () => {
          server.off("error", reject)
          resolve()
        })
      }),
    catch: (cause) => socketError("listen", cause),
  })

const connection = (
  socket: net.Socket,
  coordinator: Coordinator,
  maxFrameBytes: number,
) =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Buffer>()
    let closed = false
    const close = () => {
      if (!closed) {
        closed = true
        socket.destroy()
      }
    }
    const onData = (chunk: Buffer) => Queue.offerUnsafe(input, chunk)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        socket.on("data", onData)
        socket.on("end", close)
        socket.on("error", close)
        socket.on("close", close)
      }),
      () =>
        Effect.sync(() => {
          socket.off("data", onData)
          socket.off("end", close)
          socket.off("error", close)
          socket.off("close", close)
          Queue.shutdown(input)
          close()
        }),
    )
    const framer = new NdjsonFramer(maxFrameBytes)
    let hello = false
    let highestId = -1
    const send = (value: unknown) =>
      Effect.sync(() => {
        if (!closed && !socket.destroyed) socket.write(encodeFrame(value))
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
        yield* coordinator.status.pipe(
          Stream.runForEach((status) => send({ type: "status", status })),
          Effect.forkScoped,
        )
        yield* coordinator.states.pipe(
          Stream.runForEach((snapshot) => send({ type: "state", snapshot })),
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
          Effect.try({
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
    ).pipe(Effect.forkScoped)
    // A natural close completes this connection-local scope, so its listener
    // and forwarding-fiber finalizers run without server shutdown.
    yield* Effect.callback<void>((resume) => {
      const done = () => resume(Effect.void)
      socket.once("close", done)
      return Effect.sync(() => socket.off("close", done))
    })
  })

/** Scoped Unix listener. Accepted sockets enter a server-owned FiberSet. */
export const layer = Layer.effect(
  MusicSessionServerService,
  Effect.gen(function* () {
    const config = (yield* MusicSessionConfig).options
    const coordinator = yield* MusicSessionCoordinator
    const runConnection = yield* FiberSet.makeRuntime<never, void, never>()
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      runConnection(
        Effect.scoped(connection(socket, coordinator, config.maxFrameBytes)),
      )
    })
    yield* Effect.acquireRelease(listen(server, config.socketPath), () =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          for (const socket of sockets) socket.destroy()
        })
        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve) => server.close(() => resolve())),
          catch: () => undefined,
        }).pipe(Effect.ignore)
        yield* Effect.tryPromise({
          try: () =>
            unlink(config.socketPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error
            }),
          catch: () => undefined,
        }).pipe(Effect.ignore)
      }),
    )
    return MusicSessionServerService.of({ coordinator })
  }),
)

/** Compatibility adapter: it owns one explicit Effect scope and nothing else. */
export async function startMusicSessionServer(
  options: MusicSessionOptions,
  provider?: LegacySessionProvider,
): Promise<MusicSessionServer> {
  const { layer: configLayer } = await import("./config.ts")
  const scope = await Effect.runPromise(Scope.make())
  try {
    const selectedProvider = provider
      ? layerFromLegacy(provider)
      : providerLayer
    const coordinatorWithProvider = Layer.provide(
      coordinatorLayer,
      selectedProvider,
    )
    const serverWithCoordinator = Layer.provide(layer, coordinatorWithProvider)
    const graph = Layer.provide(serverWithCoordinator, configLayer(options))
    const context = await Effect.runPromise(
      Scope.provide(scope)(Layer.build(graph)),
    )
    const service = Context.get(context, MusicSessionServerService)
    let closed = false
    return {
      coordinator: service.coordinator,
      async close() {
        if (!closed) {
          closed = true
          await Effect.runPromise(Scope.close(scope, Exit.void))
        }
      },
    }
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw cause
  }
}

export { createFakeProvider }
