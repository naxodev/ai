import { expect } from "bun:test"
import net from "node:net"
import { randomUUID } from "node:crypto"
import { Effect, Latch, Layer, Schema, Stream } from "effect"
import { AudioCapture, layerFromAdapters } from "../audio/capture.ts"
import {
  AUDIO_PENDING_TASK_LIMIT,
  AudioSourceList,
  audioVisualizationCapabilities,
} from "../audio/schema.ts"
import {
  baselineCapabilities,
  PROTOCOL,
  ResponseSchema,
  type Response,
} from "../session/protocol.ts"
import { NdjsonFramer } from "../session/framing.ts"
import {
  createFakeProvider,
  startMusicSessionServer,
} from "../session/server.ts"
import { testUnixSession as test } from "./unix-session.ts"

const bounded = <A>(promise: Promise<A>): Promise<A> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("request stalled behind cleanup")),
      1_000,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

const peer = async (path: string) => {
  const socket = net.connect(path)
  const framer = new NdjsonFramer()
  const pending = new Map<number, (response: Response) => void>()
  let nextId = 0
  socket.on("data", (chunk) => {
    for (const frame of framer.push(chunk)) {
      if (
        typeof frame !== "object" ||
        frame === null ||
        !("type" in frame) ||
        frame.type !== "response"
      )
        continue
      const response = Schema.decodeUnknownSync(ResponseSchema)(frame)
      pending.get(response.requestId)?.(response)
      pending.delete(response.requestId)
    }
  })
  const request = (fields: Record<string, unknown>) => {
    const requestId = nextId++
    const response = new Promise<Response>((resolve) =>
      pending.set(requestId, resolve),
    )
    socket.write(`${JSON.stringify({ ...fields, requestId })}\n`)
    return response
  }
  await bounded(
    request({
      type: "hello",
      protocol: PROTOCOL,
      packageVersion: "test",
      clientId: randomUUID(),
      hostKind: "test",
      capabilities: [
        ...baselineCapabilities,
        ...audioVisualizationCapabilities,
      ],
    }),
  )
  return { request, close: () => socket.destroy() }
}

const fixture = async (holdInitialStart = false) => {
  const path = `/tmp/music-retirement-${process.pid}-${randomUUID()}.sock`
  const closing = Latch.makeUnsafe()
  const release = Latch.makeUnsafe()
  const starting = Latch.makeUnsafe()
  const releaseStart = Latch.makeUnsafe()
  let starts = 0
  let releases = 0
  let finalizedConnections = 0
  let featureBindings = 0
  let activeFeatureBindings = 0
  let maxFeatureBindings = 0
  const serverClosing = Promise.withResolvers<void>()
  const connectionFinalized = Promise.withResolvers<void>()
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
    {
      onConnectionFinalized: () => {
        finalizedConnections += 1
        connectionFinalized.resolve()
      },
      onClosing: () => serverClosing.resolve(),
    },
    (daemonInstanceId) => {
      const captureLayer = layerFromAdapters({
        daemonInstanceId,
        observations: Stream.never,
        resolver: {
          list: () =>
            Effect.succeed({
              availability: "available",
              sources: [
                {
                  mode: "process",
                  label: "Offline fixture",
                  observationSequence: 1,
                  capabilities: {
                    spectrum: "measured",
                    envelope: "absent",
                    channels: "absent",
                  },
                  identity: {
                    kind: "native",
                    processIdentifier: 42,
                    launchIdentity: "fixture",
                    executableIdentity: "fixture",
                    coreAudioObject: "fixture",
                  },
                },
              ],
            }),
          revalidate: (source) => Effect.succeed(source),
          confirm: () => Effect.succeed("same"),
        },
        adapter: {
          availability: "available",
          start: () =>
            Effect.gen(function* () {
              starts += 1
              const first = starts === 1
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  if (first) {
                    yield* Latch.open(closing)
                    yield* Latch.await(release)
                  }
                  releases += 1
                }),
              )
              yield* Latch.open(starting)
              if (first && holdInitialStart) yield* Latch.await(releaseStart)
              return { frames: Stream.never }
            }),
        },
      })
      return Layer.effect(
        AudioCapture,
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          return AudioCapture.of({
            ...capture,
            subscribeFeatures: (id) =>
              Stream.unwrap(
                Effect.sync(() => {
                  featureBindings += 1
                  activeFeatureBindings += 1
                  maxFeatureBindings = Math.max(
                    maxFeatureBindings,
                    activeFeatureBindings,
                  )
                  return capture.subscribeFeatures(id).pipe(
                    Stream.ensuring(
                      Effect.sync(() => {
                        activeFeatureBindings -= 1
                      }),
                    ),
                  )
                }),
              ),
          })
        }),
      ).pipe(Layer.provide(captureLayer))
    },
  )
  const first = await peer(path)
  const healthy = await peer(path)
  const list = async () => {
    const result = await bounded(first.request({ type: "audio-sources" }))
    if (!result.ok) throw new Error("source request failed")
    const token = Schema.decodeUnknownSync(AudioSourceList)(result.data)
      .sources[0]?.token
    if (!token) throw new Error("missing fixture token")
    return token
  }
  await bounded(first.request({ type: "audio-subscribe", channel: "features" }))
  const initialStart = first.request({
    type: "audio-start",
    token: await list(),
  })
  await bounded(Effect.runPromise(Latch.await(starting)))
  if (!holdInitialStart)
    expect(await bounded(initialStart)).toMatchObject({
      ok: true,
      data: { type: "started" },
    })
  return {
    server,
    first,
    healthy,
    list,
    closing,
    release,
    initialStart,
    serverClosing: serverClosing.promise,
    connectionFinalized: connectionFinalized.promise,
    counts: () => ({
      starts,
      releases,
      finalizedConnections,
      featureBindings,
      activeFeatureBindings,
      maxFeatureBindings,
    }),
    cleanup: async () => {
      await Effect.runPromise(Latch.open(release))
      await Effect.runPromise(Latch.open(releaseStart))
      first.close()
      healthy.close()
      await server.close()
    },
  }
}

test("feature unsubscribe fences immediately while same-socket playback and peers remain responsive", async () => {
  const probe = await fixture()
  try {
    const unsubscribed = probe.first.request({
      type: "audio-unsubscribe",
      channel: "features",
    })
    await bounded(Effect.runPromise(Latch.await(probe.closing)))
    expect(await bounded(unsubscribed)).toMatchObject({
      ok: true,
      data: { type: "unsubscribed", channel: "features" },
    })
    expect(
      await bounded(probe.first.request({ type: "transport", action: "play" })),
    ).toMatchObject({ ok: true, data: { action: "play" } })
    expect(
      await bounded(probe.healthy.request({ type: "audio-sources" })),
    ).toMatchObject({ ok: true })
    const token = await probe.list()
    for (let index = 0; index < 20; index++) {
      expect(
        await bounded(
          probe.first.request({ type: "audio-subscribe", channel: "features" }),
        ),
      ).toMatchObject({ ok: true })
      expect(
        await bounded(
          probe.first.request({
            type: "audio-unsubscribe",
            channel: "features",
          }),
        ),
      ).toMatchObject({ ok: true })
    }
    await bounded(
      probe.first.request({ type: "audio-subscribe", channel: "features" }),
    )
    const started = probe.first.request({ type: "audio-start", token })
    await bounded(probe.first.request({ type: "transport", action: "play" }))
    expect(probe.counts()).toMatchObject({
      starts: 1,
      releases: 0,
      featureBindings: 1,
      activeFeatureBindings: 0,
      maxFeatureBindings: 1,
    })
    await Effect.runPromise(Latch.open(probe.release))
    expect(await bounded(started)).toMatchObject({
      ok: true,
      data: { type: "started", generation: 2 },
    })
    expect(probe.counts()).toMatchObject({
      starts: 2,
      releases: 1,
      featureBindings: 2,
      activeFeatureBindings: 1,
      maxFeatureBindings: 1,
    })
    expect(
      await bounded(probe.first.request({ type: "audio-stop" })),
    ).toMatchObject({ ok: true, data: { type: "stopped", generation: 2 } })
    await bounded(
      probe.first.request({ type: "audio-subscribe", channel: "status" }),
    )
    await bounded(
      probe.first.request({ type: "audio-unsubscribe", channel: "status" }),
    )
    expect(
      await bounded(probe.first.request({ type: "transport", action: "play" })),
    ).toMatchObject({ ok: true })
  } finally {
    await probe.cleanup()
  }
})

test("feature retirement cancels an acquiring start before admitting the next generation", async () => {
  const probe = await fixture(true)
  try {
    const unsubscribe = probe.first.request({
      type: "audio-unsubscribe",
      channel: "features",
    })
    await bounded(Effect.runPromise(Latch.await(probe.closing)))
    expect(await bounded(unsubscribe)).toMatchObject({
      ok: true,
      data: { type: "unsubscribed" },
    })
    expect(await bounded(probe.initialStart)).toMatchObject({
      ok: true,
      data: { type: "rejected", reason: "canceled" },
    })
    await bounded(
      probe.first.request({ type: "audio-subscribe", channel: "features" }),
    )
    const next = probe.first.request({
      type: "audio-start",
      token: await probe.list(),
    })
    expect(
      await bounded(probe.first.request({ type: "transport", action: "play" })),
    ).toMatchObject({ ok: true })
    expect(probe.counts()).toMatchObject({
      starts: 1,
      releases: 0,
      featureBindings: 1,
    })
    await Effect.runPromise(Latch.open(probe.release))
    expect(await bounded(next)).toMatchObject({
      ok: true,
      data: { type: "started", generation: 2 },
    })
    expect(
      await bounded(probe.first.request({ type: "audio-stop" })),
    ).toMatchObject({ ok: true, data: { type: "stopped", generation: 2 } })
  } finally {
    await probe.cleanup()
  }
})

test("connection shutdown joins retired feature cleanup instead of abandoning its native finalizer", async () => {
  const probe = await fixture()
  try {
    const unsubscribe = probe.first.request({
      type: "audio-unsubscribe",
      channel: "features",
    })
    await bounded(Effect.runPromise(Latch.await(probe.closing)))
    await bounded(unsubscribe)
    probe.first.close()
    probe.healthy.close()
    let closed = false
    const closing = probe.server.close().then(() => {
      closed = true
    })
    await bounded(probe.serverClosing)
    await bounded(probe.connectionFinalized)
    expect(closed).toBe(false)
    expect(probe.counts().finalizedConnections).toBe(1)
    expect(probe.counts().releases).toBe(0)
    await Effect.runPromise(Latch.open(probe.release))
    await bounded(closing)
    expect(probe.counts()).toMatchObject({
      releases: 1,
      finalizedConnections: 2,
    })
  } finally {
    await probe.cleanup()
  }
})

test("retirement preserves the audio request budget and fences pending starts without blocking playback", async () => {
  const probe = await fixture()
  try {
    const unsubscribe = probe.first.request({
      type: "audio-unsubscribe",
      channel: "features",
    })
    await bounded(Effect.runPromise(Latch.await(probe.closing)))
    await bounded(unsubscribe)
    await bounded(
      probe.first.request({ type: "audio-subscribe", channel: "features" }),
    )
    const token = await probe.list()
    const starts = Array.from({ length: AUDIO_PENDING_TASK_LIMIT }, () =>
      probe.first.request({ type: "audio-start", token }),
    )
    expect(
      await bounded(probe.first.request({ type: "audio-start", token })),
    ).toMatchObject({
      ok: false,
      error: { code: "SERVER_BUSY" },
    })
    expect(
      await bounded(probe.first.request({ type: "transport", action: "play" })),
    ).toMatchObject({ ok: true })
    expect(probe.counts()).toMatchObject({ starts: 1, releases: 0 })
    await bounded(
      probe.first.request({ type: "audio-unsubscribe", channel: "features" }),
    )
    for (const result of await bounded(Promise.all(starts)))
      expect(result).toMatchObject({
        ok: true,
        data: { type: "rejected", reason: "canceled" },
      })
    // Canceled waiters release their budget before the native finalizer does.
    await bounded(
      probe.first.request({ type: "audio-subscribe", channel: "features" }),
    )
    const freshStart = probe.first.request({ type: "audio-start", token })
    await bounded(probe.first.request({ type: "transport", action: "play" }))
    await Effect.runPromise(Latch.open(probe.release))
    expect(await bounded(freshStart)).toMatchObject({
      ok: true,
      data: { type: "started", generation: 2 },
    })
  } finally {
    await probe.cleanup()
  }
})
