import { expect } from "bun:test"
import net from "node:net"
import { randomUUID } from "node:crypto"
import {
  Deferred,
  Effect,
  Fiber,
  Latch,
  Layer,
  Schema,
  Scope,
  Stream,
} from "effect"
import { AudioCapture, layerFromAdapters } from "../audio/capture.ts"
import {
  AUDIO_PENDING_TASK_LIMIT,
  AudioSourceList,
  audioVisualizationCapabilities,
  type AudioFeatureFrame,
  type ResolvedCaptureSource,
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
  const closed = Promise.withResolvers<void>()
  socket.on("close", () => closed.resolve())
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
  const prepare = (fields: Record<string, unknown>) => {
    const requestId = nextId++
    const response = new Promise<Response>((resolve) =>
      pending.set(requestId, resolve),
    )
    return { frame: `${JSON.stringify({ ...fields, requestId })}\n`, response }
  }
  const batch = (requests: ReadonlyArray<Record<string, unknown>>) => {
    const prepared = requests.map(prepare)
    socket.write(prepared.map((request) => request.frame).join(""))
    return prepared.map((request) => request.response)
  }
  const request = (fields: Record<string, unknown>) => {
    const prepared = prepare(fields)
    socket.write(prepared.frame)
    return prepared.response
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
  return {
    request,
    batch,
    closed: closed.promise,
    close: () => socket.destroy(),
  }
}

const fixture = async (
  holdInitialStart = false,
  options: { readonly failRelease?: boolean } = {},
) => {
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
  const failures: unknown[] = []
  const serverClosing = Promise.withResolvers<void>()
  const connectionFinalized = Promise.withResolvers<void>()
  const rebound = Promise.withResolvers<void>()
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
    {
      onConnectionFailure: (cause) => {
        failures.push(cause)
      },
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
                    if (options.failRelease)
                      yield* Effect.die(new Error("adapter finalizer failed"))
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
            subscribeFeatures: (
              id: string,
              options?: { readonly detachOnClose?: boolean },
            ) =>
              Stream.unwrap(
                Effect.sync(() => {
                  featureBindings += 1
                  if (featureBindings > 1) rebound.resolve()
                  activeFeatureBindings += 1
                  maxFeatureBindings = Math.max(
                    maxFeatureBindings,
                    activeFeatureBindings,
                  )
                  return capture.subscribeFeatures(id, options).pipe(
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
    rebound: rebound.promise,
    failureCount: () => failures.length,
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
    const started = probe.first.request({
      type: "audio-start",
      token: await probe.list(),
    })
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
    expect(await bounded(probe.initialStart)).toMatchObject({
      ok: true,
      data: { type: "rejected", reason: "canceled" },
    })
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
    const freshStart = probe.first.request({
      type: "audio-start",
      token: await probe.list(),
    })
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

const fakeSource: ResolvedCaptureSource = {
  mode: "process",
  label: "Offline authority fixture",
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
}

// Capture authority is independent of feature sinks. This fake makes the
// revocation boundary observable without delegating it to a stream finalizer.
const authorityFixture = async (
  options: {
    readonly features?: boolean
    readonly acquiring?: boolean
    readonly failFeatureClose?: boolean
  } = {},
) => {
  const path = `/tmp/music-authority-${process.pid}-${randomUUID()}.sock`
  const cleanupEntered = Latch.makeUnsafe()
  const releaseCleanup = Latch.makeUnsafe()
  const startEntered = Latch.makeUnsafe()
  const featuresEntered = Latch.makeUnsafe()
  const featureClosing = Latch.makeUnsafe()
  const releaseFeature = Latch.makeUnsafe(!options.failFeatureClose)
  const rebound = Promise.withResolvers<void>()
  const failure = Promise.withResolvers<void>()
  const failures: unknown[] = []
  const tokens = new Map<string, string>()
  const interests = new Set<string>()
  const attempts = new Map<string, Deferred.Deferred<void>>()
  let generation = 0
  let issued = 0
  let bindings = 0
  let revocations = 0
  let cleanupStarts = 0
  let cleanup: Fiber.Fiber<void> | undefined
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
    {
      onConnectionFailure: (cause) => {
        failures.push(cause)
        failure.resolve()
      },
    },
    () =>
      Layer.effect(
        AudioCapture,
        Effect.gen(function* () {
          const ownerScope = yield* Scope.Scope
          const beginDetach = (id: string) =>
            Effect.gen(function* () {
              revocations += 1
              for (const [token, owner] of tokens)
                if (owner === id) tokens.delete(token)
              const owned = interests.delete(id)
              const canceled = attempts.get(id)
              if (canceled) yield* Deferred.succeed(canceled, undefined)
              if (owned && !cleanup) {
                cleanup = yield* Effect.gen(function* () {
                  cleanupStarts += 1
                  yield* Latch.open(cleanupEntered)
                  yield* Latch.await(releaseCleanup)
                }).pipe(Effect.forkIn(ownerScope, { uninterruptible: true }))
              }
              return cleanup ? Fiber.join(cleanup) : Effect.void
            })
          const detach = (id: string) => beginDetach(id).pipe(Effect.flatten)
          const capture = {
            beginDetach,
            detach,
            listSources: (id: string) =>
              Effect.sync(() => {
                const token = `fixture-${++issued}`
                tokens.set(token, id)
                return {
                  availability: "available" as const,
                  sources: [
                    {
                      token,
                      mode: fakeSource.mode,
                      label: fakeSource.label,
                      capabilities: fakeSource.capabilities,
                    },
                  ],
                }
              }),
            start: (id: string, token: string) =>
              Effect.gen(function* () {
                if (tokens.get(token) !== id)
                  return {
                    type: "rejected" as const,
                    reason: "unknown-token" as const,
                  }
                const admitted = ++generation
                interests.add(id)
                yield* Latch.open(startEntered)
                if (options.acquiring && admitted === 1) {
                  const cancel = Deferred.makeUnsafe<void>()
                  attempts.set(id, cancel)
                  return yield* Deferred.await(cancel).pipe(
                    Effect.as({
                      type: "rejected" as const,
                      reason: "canceled" as const,
                    }),
                    Effect.ensuring(
                      Effect.suspend(() =>
                        cleanup ? Fiber.join(cleanup) : Effect.void,
                      ),
                    ),
                    Effect.ensuring(
                      Effect.sync(() => {
                        attempts.delete(id)
                      }),
                    ),
                  )
                }
                return {
                  type: "started" as const,
                  generation: admitted,
                  source: fakeSource.identity,
                }
              }),
            stop: (id: string) =>
              detach(id).pipe(
                Effect.as({
                  type: "rejected" as const,
                  reason: "not-joined" as const,
                }),
              ),
            renew: (id: string, current: number) =>
              Effect.sync(() =>
                interests.has(id)
                  ? { type: "renewed" as const, generation: current }
                  : {
                      type: "rejected" as const,
                      reason: "not-joined" as const,
                    },
              ),
            subscribeStatus: () => Stream.never,
            subscribeFeatures: (
              id: string,
              streamOptions?: { readonly detachOnClose?: boolean },
            ) =>
              Stream.callback<AudioFeatureFrame>(() =>
                Effect.gen(function* () {
                  bindings += 1
                  if (bindings > 1) rebound.resolve()
                  yield* Latch.open(featuresEntered)
                  yield* Effect.addFinalizer(() =>
                    Effect.gen(function* () {
                      yield* Latch.open(featureClosing)
                      yield* Latch.await(releaseFeature)
                      if (streamOptions?.detachOnClose !== false)
                        yield* detach(id)
                      if (options.failFeatureClose)
                        yield* Effect.die(new Error("feature finalizer failed"))
                    }),
                  )
                }),
              ),
            status: () => Effect.succeed({ type: "idle" as const }),
          }
          return AudioCapture.of(capture)
        }),
      ),
  )
  const first = await peer(path)
  const healthy = await peer(path)
  const tokenFrom = (result: Response) => {
    if (!result.ok) throw new Error("source request failed")
    const token = Schema.decodeUnknownSync(AudioSourceList)(result.data)
      .sources[0]?.token
    if (!token) throw new Error("missing fixture token")
    return token
  }
  const list = async () =>
    tokenFrom(await bounded(first.request({ type: "audio-sources" })))
  if (options.features) {
    await bounded(
      first.request({ type: "audio-subscribe", channel: "features" }),
    )
    await bounded(Effect.runPromise(Latch.await(featuresEntered)))
  }
  const initialStart = first.request({
    type: "audio-start",
    token: await list(),
  })
  await bounded(Effect.runPromise(Latch.await(startEntered)))
  if (!options.acquiring)
    expect(await bounded(initialStart)).toMatchObject({
      ok: true,
      data: { type: "started" },
    })
  return {
    first,
    healthy,
    list,
    tokenFrom,
    initialStart,
    cleanupEntered,
    releaseCleanup,
    featureClosing,
    releaseFeature,
    rebound: rebound.promise,
    failure: failure.promise,
    counts: () => ({
      bindings,
      revocations,
      cleanupStarts,
      failures: failures.length,
      interests: interests.size,
    }),
    tokenValid: (token: string) => tokens.has(token),
    cleanup: async () => {
      await Effect.runPromise(Latch.open(releaseCleanup))
      await Effect.runPromise(Latch.open(releaseFeature))
      first.close()
      healthy.close()
      await server.close()
    },
  }
}

test("a same-batch renewal cannot revive interest after feature unsubscribe acknowledges", async () => {
  const probe = await authorityFixture({ features: true })
  try {
    const replies = probe.first.batch([
      { type: "audio-unsubscribe", channel: "features" },
      { type: "audio-renew", generation: 1 },
      { type: "transport", action: "play" },
    ])
    const results = await bounded(Promise.all(replies))
    expect(results[0]).toMatchObject({
      ok: true,
      data: { type: "unsubscribed" },
    })
    expect(results[1]).toMatchObject({
      ok: true,
      data: { type: "rejected", reason: "not-joined" },
    })
    expect(results[2]).toMatchObject({ ok: true, data: { action: "play" } })
    expect(probe.counts().interests).toBe(0)
  } finally {
    await probe.cleanup()
  }
})

test("a same-batch source token issued after unsubscribe survives old feature cleanup", async () => {
  const probe = await authorityFixture({ features: true })
  try {
    const replies = await bounded(
      Promise.all(
        probe.first.batch([
          { type: "audio-unsubscribe", channel: "features" },
          { type: "audio-sources" },
        ]),
      ),
    )
    const listed = replies[1]
    if (!listed) throw new Error("missing source response")
    const token = probe.tokenFrom(listed)
    await bounded(Effect.runPromise(Latch.await(probe.cleanupEntered)))
    await bounded(
      probe.first.request({ type: "audio-subscribe", channel: "features" }),
    )
    const next = probe.first.request({ type: "audio-start", token })
    await bounded(probe.first.request({ type: "transport", action: "play" }))
    await Effect.runPromise(Latch.open(probe.releaseCleanup))
    expect(await bounded(next)).toMatchObject({
      ok: true,
      data: { type: "started", generation: 2 },
    })
    expect(probe.counts()).toMatchObject({ cleanupStarts: 1, failures: 0 })
  } finally {
    await probe.cleanup()
  }
})

test("unsubscribe revokes a completed capture even when no feature stream was bound", async () => {
  const probe = await authorityFixture()
  try {
    await bounded(
      probe.first.request({ type: "audio-unsubscribe", channel: "features" }),
    )
    expect(
      await bounded(
        probe.first.request({ type: "audio-renew", generation: 1 }),
      ),
    ).toMatchObject({
      ok: true,
      data: { type: "rejected", reason: "not-joined" },
    })
    await bounded(Effect.runPromise(Latch.await(probe.cleanupEntered)))
    expect(probe.counts()).toMatchObject({
      bindings: 0,
      interests: 0,
      cleanupStarts: 1,
    })
    expect(
      await bounded(probe.first.request({ type: "transport", action: "play" })),
    ).toMatchObject({ ok: true })
  } finally {
    await probe.cleanup()
  }
})

test("an acquiring capture without a feature stream cannot erase tokens issued after unsubscribe", async () => {
  const probe = await authorityFixture({ acquiring: true })
  try {
    const results = await bounded(
      Promise.all(
        probe.first.batch([
          { type: "audio-unsubscribe", channel: "features" },
          { type: "audio-sources" },
          { type: "audio-renew", generation: 1 },
        ]),
      ),
    )
    const listed = results[1]
    if (!listed) throw new Error("missing source response")
    const token = probe.tokenFrom(listed)
    expect(results[2]).toMatchObject({
      ok: true,
      data: { type: "rejected", reason: "not-joined" },
    })
    const next = probe.first.request({ type: "audio-start", token })
    expect(
      await bounded(probe.first.request({ type: "transport", action: "play" })),
    ).toMatchObject({ ok: true })
    await bounded(Effect.runPromise(Latch.await(probe.cleanupEntered)))
    await Effect.runPromise(Latch.open(probe.releaseCleanup))
    expect(await bounded(probe.initialStart)).toMatchObject({
      ok: true,
      data: { type: "rejected", reason: "canceled" },
    })
    expect(await bounded(next)).toMatchObject({
      ok: true,
      data: { type: "started", generation: 2 },
    })
  } finally {
    await probe.cleanup()
  }
})

test("repeated unsubscribe revokes fresh tokens immediately while sharing one cleanup barrier", async () => {
  const probe = await authorityFixture({ features: true })
  try {
    await bounded(
      probe.first.request({ type: "audio-unsubscribe", channel: "features" }),
    )
    await bounded(Effect.runPromise(Latch.await(probe.cleanupEntered)))
    for (let index = 0; index < 20; index++) {
      const stale = await probe.list()
      await bounded(
        probe.first.request({ type: "audio-unsubscribe", channel: "features" }),
      )
      expect(probe.tokenValid(stale)).toBe(false)
    }
    const fresh = await probe.list()
    expect(probe.tokenValid(fresh)).toBe(true)
    const next = probe.first.request({ type: "audio-start", token: fresh })
    expect(
      await bounded(probe.first.request({ type: "transport", action: "play" })),
    ).toMatchObject({ ok: true })
    expect(probe.counts()).toMatchObject({ revocations: 21, cleanupStarts: 1 })
    await Effect.runPromise(Latch.open(probe.releaseCleanup))
    expect(await bounded(next)).toMatchObject({
      ok: true,
      data: { type: "started", generation: 2 },
    })
  } finally {
    await probe.cleanup()
  }
})

test("a failed feature finalizer reports once and cannot release the barrier for rebinding", async () => {
  const probe = await authorityFixture({
    features: true,
    failFeatureClose: true,
  })
  try {
    await bounded(
      probe.first.request({ type: "audio-unsubscribe", channel: "features" }),
    )
    await bounded(Effect.runPromise(Latch.await(probe.featureClosing)))
    await bounded(
      probe.first.request({ type: "audio-subscribe", channel: "features" }),
    )
    await Effect.runPromise(Latch.open(probe.releaseCleanup))
    await Effect.runPromise(Latch.open(probe.releaseFeature))
    const result = await bounded(
      Promise.race([
        probe.failure.then(() => "failed"),
        probe.rebound.then(() => "rebound"),
      ]),
    )
    expect(result).toBe("failed")
    await bounded(probe.first.closed)
    expect(probe.counts()).toMatchObject({ failures: 1, bindings: 1 })
    expect(
      await bounded(
        probe.healthy.request({ type: "transport", action: "play" }),
      ),
    ).toMatchObject({ ok: true })
  } finally {
    await probe.cleanup()
  }
})

test("a failed adapter finalizer is reported once when teardown replays the cached cleanup", async () => {
  const probe = await fixture(false, { failRelease: true })
  try {
    await bounded(
      probe.first.request({ type: "audio-unsubscribe", channel: "features" }),
    )
    await bounded(Effect.runPromise(Latch.await(probe.closing)))
    // A resubscribe during retirement must not bind another sink if cleanup fails.
    await bounded(
      probe.first.request({ type: "audio-subscribe", channel: "features" }),
    )
    await Effect.runPromise(Latch.open(probe.release))
    const outcome = await bounded(
      Promise.race([
        probe.connectionFinalized.then(() => "closed" as const),
        probe.rebound.then(() => "rebound" as const),
      ]),
    )
    expect(outcome).toBe("closed")
    // Teardown reports on the server runtime after the connection hook.
    for (let turn = 0; turn < 8; turn++)
      await new Promise((resolve) => setImmediate(resolve))
    expect(probe.failureCount()).toBe(1)
    expect(probe.counts()).toMatchObject({
      featureBindings: 1,
      releases: 0,
    })
    expect(
      await bounded(
        probe.healthy.request({ type: "transport", action: "play" }),
      ),
    ).toMatchObject({ ok: true })
  } finally {
    // Server close still observes the propagated cleanup defect.
    await probe.cleanup().catch((error: unknown) => {
      expect(String(error)).toContain("adapter finalizer failed")
    })
  }
})
