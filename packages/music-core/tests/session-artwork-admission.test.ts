import { expect, test as baseTest } from "bun:test"
import { randomUUID } from "node:crypto"
import net from "node:net"
import { Effect, Exit, Layer, Queue, Ref, Scope } from "effect"
import { emptyPlayer } from "../types.ts"
import { createMusicSessionClient } from "../session/client.ts"
import { layer as configLayer } from "../session/config.ts"
import { makeCoordinatorProviderFixture } from "../session/provider.ts"
import { NdjsonFramer, encodeFrame } from "../session/framing.ts"
import {
  decodeServerFrame,
  PROTOCOL,
  type Response,
} from "../session/protocol.ts"
import { layerWithHooks, type ServerLifecycleHooks } from "../session/server.ts"
import { createSessionTest, type SessionTestFn } from "./unix-session.ts"

const names = [
  "same-client play completes before blocked artwork is released",
  "artwork response waiters are bounded and capacity recovers",
  "disconnect and shutdown finalize artwork waiters and forwarding",
  "pending artwork preserves serial validation and response correlation",
  "pending artwork leaves global transport FIFO authoritative",
] as const
const test: SessionTestFn = createSessionTest(baseTest, new Set(names))
const identity = {
  id: "recording",
  name: "Song",
  artists: "Artist",
  album: "Album",
  duration_ms: 180_000,
}
const within = <A>(promise: Promise<A>) =>
  Effect.runPromise(
    Effect.promise(() => promise).pipe(Effect.timeout("2 seconds")),
  )

const setup = async (hooks: ServerLifecycleHooks = {}) => {
  const socketPath = `/tmp/music-art-${process.pid}-${randomUUID()}.sock`
  const provider = await Effect.runPromise(
    makeCoordinatorProviderFixture({
      ...emptyPlayer(),
      track: { ...identity, uri: "system:recording" },
    }),
  )
  await Effect.runPromise(provider.blockArtwork)
  const scope = await Effect.runPromise(Scope.make())
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void))
  try {
    await Effect.runPromise(
      Scope.provide(scope)(
        Layer.build(
          Layer.provide(
            layerWithHooks(hooks, provider.layer),
            configLayer({ socketPath, mandatoryOutboundQueueCapacity: 4 }),
          ),
        ),
      ),
    )
    const client = await createMusicSessionClient({
      socketPath,
      clientId: "artwork-admission",
      hostKind: "test",
    })
    return { provider, client, close, socketPath }
  } catch (cause) {
    await close()
    throw cause
  }
}

test(names[0], async () => {
  const { provider, client, close } = await setup()
  try {
    let artworkSettled = false
    const artwork = client.artwork(identity).finally(() => {
      artworkSettled = true
    })
    void artwork.catch(() => {})
    await Effect.runPromise(Queue.take(provider.artworkStarts))
    await expect(within(client.play())).resolves.toEqual({ action: "play" })
    expect(artworkSettled).toBe(false)
    expect(await Effect.runPromise(Ref.get(provider.calls))).toEqual([
      { action: "play" },
    ])
    await Effect.runPromise(provider.releaseArtwork)
    await expect(within(artwork)).resolves.toEqual({ type: "unavailable" })
  } finally {
    await client.dispose()
    await close()
  }
})

test(names[3], async () => {
  const { provider, client, close, socketPath } = await setup()
  const socket = net.createConnection(socketPath)
  const responses = await Effect.runPromise(Queue.unbounded<Response>())
  const framer = new NdjsonFramer()
  socket.on("data", (chunk: Buffer) => {
    for (const raw of framer.push(chunk)) {
      const frame = decodeServerFrame(raw)
      if (frame.type === "response") Queue.offerUnsafe(responses, frame)
    }
  })
  const receive = () => within(Effect.runPromise(Queue.take(responses)))
  const send = (request: unknown) => socket.write(encodeFrame(request))
  try {
    await within(
      new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      }),
    )
    send({
      type: "hello",
      requestId: 1,
      protocol: PROTOCOL,
      packageVersion: "0.0.0",
      clientId: "raw",
      hostKind: "test",
      capabilities: ["native-artwork", "state-replay"],
    })
    expect(await receive()).toMatchObject({ requestId: 1, ok: true })
    send({ type: "artwork", requestId: 2, identity })
    await Effect.runPromise(Queue.take(provider.artworkStarts))
    send({ type: "artwork", requestId: 2, identity })
    expect(await receive()).toMatchObject({
      requestId: 2,
      ok: false,
      error: { code: "DUPLICATE_REQUEST_ID" },
    })
    send({ type: "transport", requestId: 3, action: "unknown" })
    expect(await receive()).toMatchObject({
      requestId: 3,
      ok: false,
      error: { code: "UNSUPPORTED_ACTION" },
    })
    send({ type: "state", requestId: 3 })
    expect(await receive()).toMatchObject({
      requestId: 3,
      ok: false,
      error: { code: "DUPLICATE_REQUEST_ID" },
    })
    send({ type: "transport", requestId: 4, action: "play" })
    expect(await receive()).toMatchObject({
      requestId: 4,
      ok: false,
      error: { code: "UNSUPPORTED_CAPABILITY" },
    })
    send({ type: "state", requestId: 5 })
    expect(await receive()).toMatchObject({ requestId: 5, ok: true })
    expect(await Effect.runPromise(Ref.get(provider.calls))).toEqual([])
    expect(await Effect.runPromise(Ref.get(provider.artworkCalls))).toBe(1)
    await Effect.runPromise(provider.releaseArtwork)
    expect(await receive()).toMatchObject({
      requestId: 2,
      ok: true,
      data: { type: "unavailable" },
    })
  } finally {
    socket.destroy()
    await client.dispose()
    await close()
    await Effect.runPromise(Queue.shutdown(responses))
  }
})

test(names[4], async () => {
  const secondAdmitted = Promise.withResolvers<void>()
  const { provider, client, close, socketPath } = await setup({
    onCommandAdmission: (action) => {
      if (action === "pause") secondAdmitted.resolve()
    },
  })
  let other: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    other = await createMusicSessionClient({
      socketPath,
      clientId: "other",
      hostKind: "test",
    })
    const artwork = client.artwork(identity)
    void artwork.catch(() => {})
    await Effect.runPromise(Queue.take(provider.artworkStarts))
    await Effect.runPromise(provider.blockTransport)
    const play = client.play()
    void play.catch(() => {})
    await within(Effect.runPromise(Queue.take(provider.transportStarts)))
    const pause = other.pause()
    void pause.catch(() => {})
    await within(secondAdmitted.promise)
    expect(await Effect.runPromise(Ref.get(provider.calls))).toEqual([
      { action: "play" },
    ])
    await Effect.runPromise(provider.releaseTransport)
    await within(Promise.all([play, pause]))
    expect(await Effect.runPromise(Ref.get(provider.calls))).toEqual([
      { action: "play" },
      { action: "pause" },
    ])
    await Effect.runPromise(provider.releaseArtwork)
    await within(artwork)
  } finally {
    await client.dispose()
    await other?.dispose()
    await close()
  }
})

test(names[1], async () => {
  const { provider, client, close } = await setup()
  try {
    const pending = Array.from({ length: 4 }, () => client.artwork(identity))
    for (const request of pending) void request.catch(() => {})
    await Effect.runPromise(Queue.take(provider.artworkStarts))
    await expect(within(client.artwork(identity))).rejects.toMatchObject({
      code: "SERVER_BUSY",
    })
    await expect(within(client.play())).resolves.toEqual({ action: "play" })
    expect(await Effect.runPromise(Ref.get(provider.artworkCalls))).toBe(1)
    await Effect.runPromise(provider.releaseArtwork)
    expect(await within(Promise.all(pending))).toEqual(
      Array.from({ length: 4 }, () => ({ type: "unavailable" })),
    )
    await expect(within(client.artwork(identity))).resolves.toEqual({
      type: "unavailable",
    })
    expect(await Effect.runPromise(Ref.get(provider.artworkCalls))).toBe(2)
  } finally {
    await client.dispose()
    await close()
  }
})

test(names[2], async () => {
  const finalized = Promise.withResolvers<void>()
  let forwarders = 0
  const { provider, client, close, socketPath } = await setup({
    onConnectionFinalized: () => finalized.resolve(),
    onForwarderStarted: () => {
      forwarders++
    },
    onForwarderFinalized: () => {
      forwarders--
    },
  })
  let survivor: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    const abandoned = client.artwork(identity)
    void abandoned.catch(() => {})
    await Effect.runPromise(Queue.take(provider.artworkStarts))
    await client.dispose()
    await within(finalized.promise)
    await expect(abandoned).rejects.toMatchObject({ code: "DISPOSED" })
    expect(forwarders).toBe(0)
    // A connection owns its waiter; the shared native read belongs to the coordinator.
    expect(await Effect.runPromise(Ref.get(provider.interruptedArtwork))).toBe(
      0,
    )
    survivor = await createMusicSessionClient({
      socketPath,
      clientId: "survivor",
      hostKind: "test",
    })
    const pending = survivor.artwork(identity)
    void pending.catch(() => {})
    await expect(within(survivor.play())).resolves.toEqual({ action: "play" })
    await within(close())
    await expect(within(pending)).rejects.toMatchObject({
      code: "CONNECTION_LOST",
    })
    expect(forwarders).toBe(0)
    expect(await Effect.runPromise(Ref.get(provider.interruptedArtwork))).toBe(
      1,
    )
    expect(await Effect.runPromise(Ref.get(provider.eventFinalizations))).toBe(
      1,
    )
    expect(await Effect.runPromise(Ref.get(provider.finalizations))).toBe(1)
  } finally {
    await client.dispose()
    await survivor?.dispose()
    await close()
  }
})
