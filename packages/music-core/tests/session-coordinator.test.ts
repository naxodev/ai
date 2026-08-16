import { expect, test } from "bun:test"
import {
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Queue,
  Result,
  Ref,
  Stream,
  Scope,
} from "effect"
import { TestClock } from "effect/testing"
import { emptyPlayer, type PlayerState } from "../types.ts"
import {
  MusicSessionConfig,
  layer as configLayer,
  layerFromConfig,
} from "../session/config.ts"
import {
  MusicSessionCoordinator,
  type PollDeadline,
  type SamplingState,
  attachPollDeadline,
  claimSampling,
  layer as coordinatorLayer,
  reservePollDeadline,
} from "../session/coordinator.ts"
import { makeCoordinatorProviderFixture } from "../session/provider.ts"

const track = (name: string): PlayerState["track"] => ({
  id: name,
  name,
  artists: "Artist",
  album: "Album",
  uri: `system:${name}`,
  duration_ms: 10_000,
})

const fixture = () =>
  Effect.runPromise(
    makeCoordinatorProviderFixture({ ...emptyPlayer(), fetched_at: 1 }),
  )
type Fixture = Awaited<ReturnType<typeof fixture>>

const graph = (
  provider: Fixture,
  capacity = 128,
  artworkCacheCapacity?: number,
) =>
  Layer.provide(
    Layer.provide(coordinatorLayer, provider.layer),
    configLayer({
      socketPath: "/tmp/music-session-test.sock",
      commandQueueCapacity: capacity,
      ...(artworkCacheCapacity === undefined ? {} : { artworkCacheCapacity }),
      reconciliationMs: { transport: 120, navigation: 150 },
      pollMs: { playing: 3_000, paused: 5_000, idle: 8_000 },
    }),
  )

const awaitSubscription = (provider: Fixture) =>
  Latch.await(provider.eventSubscribed)

const initialSample = (provider: Fixture) =>
  Effect.all([
    Queue.take(provider.sampleStarts),
    Queue.take(provider.sampleCompletions),
  ])

const snapshot = (provider: Fixture, state: PlayerState) =>
  provider.emit({ type: "snapshot", state })

const invalidation = (provider: Fixture) =>
  provider
    .emit({ type: "invalidation", reason: "stream-terminated" })
    .pipe(Effect.andThen(Queue.take(provider.eventConsumed)))

const subscribeStates = (coordinator: MusicSessionCoordinator["Service"]) =>
  Effect.gen(function* () {
    const updates = yield* Queue.unbounded<PlayerState>()
    const ready = yield* Latch.make(false)
    yield* coordinator.states.pipe(
      Stream.map((revisioned) => revisioned.state),
      Stream.runForEach((state) =>
        Queue.offer(updates, state).pipe(Effect.andThen(Latch.open(ready))),
      ),
      Effect.forkScoped,
    )
    yield* Latch.await(ready)
    yield* Queue.take(updates)
    return updates
  })

test("config defaults, overrides, ConfigProvider parity, and typed failures", async () => {
  const resolve = (layer: Layer.Layer<MusicSessionConfig, unknown>) =>
    Effect.scoped(
      Effect.gen(function* () {
        return (yield* MusicSessionConfig).options
      }).pipe(Effect.provide(layer)),
    )
  const defaults = await Effect.runPromise(
    resolve(configLayer({ socketPath: "/tmp/config.sock" })),
  )
  expect(defaults.maxFrameBytes).toBe(64 * 1024)
  expect(defaults.nativeArtworkMaxBytes).toBe(1024)
  const concrete = await Effect.runPromise(
    resolve(
      configLayer({
        socketPath: "/tmp/config.sock",
        maxFrameBytes: 512,
        commandQueueCapacity: 4,
        reconciliationMs: { transport: 7, navigation: 8 },
        pollMs: { playing: 9, paused: 10, idle: 11 },
      }),
    ),
  )
  // A small but valid frame derives a smaller native read bound; it never
  // permits a response that the mandatory lane cannot encode.
  expect(concrete.nativeArtworkMaxBytes).toBe(288)
  const fromConfig = await Effect.runPromise(
    resolve(layerFromConfig).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            MUSIC_SESSION_SOCKET: "/tmp/config.sock",
            MUSIC_SESSION_MAX_FRAME_BYTES: "512",
            MUSIC_SESSION_COMMAND_QUEUE_CAPACITY: "4",
            MUSIC_SESSION_RECONCILIATION_TRANSPORT_MS: "7",
            MUSIC_SESSION_RECONCILIATION_NAVIGATION_MS: "8",
            MUSIC_SESSION_POLL_PLAYING_MS: "9",
            MUSIC_SESSION_POLL_PAUSED_MS: "10",
            MUSIC_SESSION_POLL_IDLE_MS: "11",
          }),
        ),
      ),
    ),
  )
  expect(fromConfig).toEqual(concrete)
  const missing = await Effect.runPromise(
    resolve(layerFromConfig).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            MUSIC_SESSION_SOCKET: "/tmp/config.sock",
          }),
        ),
      ),
    ),
  )
  expect(missing.maxFrameBytes).toBe(64 * 1024)
  const malformed = await Effect.runPromise(
    resolve(layerFromConfig).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            MUSIC_SESSION_SOCKET: "/tmp/config.sock",
            MUSIC_SESSION_POLL_PLAYING_MS: "wrong",
          }),
        ),
      ),
      Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }),
    ),
  )
  expect(malformed).toMatchObject({
    _tag: "MusicSession.ConfigError",
    setting: "pollMs.playing",
  })
  for (const [setting, invalid] of [
    ["socketPath", { socketPath: "" }],
    ["maxFrameBytes", { maxFrameBytes: 0 }],
    ["maxFrameBytes", { maxFrameBytes: 131 }],
    ["commandQueueCapacity", { commandQueueCapacity: Number.NaN }],
    [
      "reconciliationMs.transport",
      { reconciliationMs: { transport: 0, navigation: 1 } },
    ],
    [
      "reconciliationMs.navigation",
      { reconciliationMs: { transport: 1, navigation: -1 } },
    ],
    ["pollMs.playing", { pollMs: { playing: 0, paused: 1, idle: 1 } }],
    [
      "pollMs.paused",
      { pollMs: { playing: 1, paused: Number.POSITIVE_INFINITY, idle: 1 } },
    ],
    [
      "pollMs.idle",
      { pollMs: { playing: 1, paused: 1, idle: Number.MAX_SAFE_INTEGER + 1 } },
    ],
  ] as const) {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          configLayer({ socketPath: "/tmp/config.sock", ...invalid }),
        ),
      ).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
      ),
    )
    expect(failure).toMatchObject({ _tag: "MusicSession.ConfigError", setting })
  }
})

test("artwork preserves authority, shares in-flight work, retries failures, and evicts", async () => {
  const provider = await fixture()
  const state = (name: string, fetched_at: number) => ({
    ...emptyPlayer(),
    track: track(name),
    fetched_at,
  })
  const identity = (name: string) => ({
    id: name,
    name,
    artists: "Artist",
    album: "Album",
    duration_ms: 10_000,
  })
  await Effect.runPromise(provider.setState(state("one", 1)))
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        yield* initialSample(provider)
        const updates = yield* subscribeStates(coordinator)
        const one = identity("one")
        const two = identity("two")

        // A mismatch never reaches the provider.
        expect(yield* coordinator.artwork(two)).toEqual({ type: "stale" })
        expect(yield* Ref.get(provider.artworkCalls)).toBe(0)

        yield* provider.setArtworkResult({ type: "available", base64: "AQID" })
        yield* provider.blockArtwork
        const first = yield* coordinator.artwork(one).pipe(Effect.forkScoped)
        yield* Latch.await(provider.artworkStarted)
        const second = yield* coordinator.artwork(one).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        expect(yield* Ref.get(provider.artworkCalls)).toBe(1)

        // Artwork never enters the command lane and a later authoritative
        // state invalidates both joined callers when the read completes.
        yield* coordinator.submit("play")
        yield* Queue.take(updates)
        yield* snapshot(provider, state("two", 2))
        expect((yield* Queue.take(updates)).track?.name).toBe("two")
        yield* provider.releaseArtwork
        expect(yield* Fiber.join(first)).toEqual({ type: "stale" })
        expect(yield* Fiber.join(second)).toEqual({ type: "stale" })

        yield* snapshot(provider, state("one", 3))
        expect((yield* Queue.take(updates)).track?.name).toBe("one")
        yield* provider.failNextArtwork()
        const failed = yield* coordinator.artwork(one).pipe(
          Effect.match({
            onSuccess: () => "success",
            onFailure: () => "failed",
          }),
        )
        expect(failed).toBe("failed")
        yield* provider.setArtworkResult({ type: "available", base64: "AQID" })
        expect(yield* coordinator.artwork(one)).toEqual({
          type: "available",
          base64: "AQID",
        })
        expect(yield* Ref.get(provider.artworkCalls)).toBe(3)

        // Capacity one evicts the oldest settled identity, so returning to it
        // triggers a fresh provider read rather than retaining unbounded data.
        yield* snapshot(provider, state("two", 4))
        expect((yield* Queue.take(updates)).track?.name).toBe("two")
        expect(yield* coordinator.artwork(two)).toEqual({
          type: "available",
          base64: "AQID",
        })
        yield* snapshot(provider, state("one", 5))
        expect((yield* Queue.take(updates)).track?.name).toBe("one")
        expect(yield* coordinator.artwork(one)).toEqual({
          type: "available",
          base64: "AQID",
        })
        expect(yield* Ref.get(provider.artworkCalls)).toBe(5)
      }).pipe(Effect.provide(graph(provider, 128, 1))),
    ),
  )
})

test("artwork caller interruption leaves an equal-key lookup owned by the coordinator", async () => {
  const provider = await fixture()
  const state = { ...emptyPlayer(), track: track("one"), fetched_at: 1 }
  const identity = {
    id: "one",
    name: "one",
    artists: "Artist",
    album: "Album",
    duration_ms: 10_000,
  }
  await Effect.runPromise(provider.setState(state))
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* provider.setArtworkResult({ type: "available", base64: "AQID" })
        yield* provider.blockArtwork
        const first = yield* coordinator
          .artwork(identity)
          .pipe(Effect.forkScoped)
        yield* Queue.take(provider.artworkStarts)
        const joined = yield* coordinator
          .artwork(identity)
          .pipe(Effect.forkScoped)
        yield* Fiber.interrupt(first)
        expect(yield* Ref.get(provider.interruptedArtwork)).toBe(0)
        yield* provider.releaseArtwork
        expect(yield* Fiber.join(joined)).toEqual({
          type: "available",
          base64: "AQID",
        })
        expect(yield* Ref.get(provider.artworkCalls)).toBe(1)
      }).pipe(Effect.provide(graph(provider, 128, 1))),
    ),
  )
})

test("artwork distinct-key admission is bounded and recovers after release", async () => {
  const provider = await fixture()
  const state = (name: string, fetched_at: number) => ({
    ...emptyPlayer(),
    track: track(name),
    fetched_at,
  })
  const identity = (name: string) => ({
    id: name,
    name,
    artists: "Artist",
    album: "Album",
    duration_ms: 10_000,
  })
  await Effect.runPromise(provider.setState(state("one", 1)))
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        yield* initialSample(provider)
        const updates = yield* subscribeStates(coordinator)
        yield* provider.setArtworkResult({ type: "available", base64: "AQID" })
        yield* provider.blockArtwork
        const first = yield* coordinator
          .artwork(identity("one"))
          .pipe(Effect.forkScoped)
        yield* Queue.take(provider.artworkStarts)
        yield* snapshot(provider, state("two", 2))
        expect((yield* Queue.take(updates)).track?.name).toBe("two")
        const busy = yield* coordinator.artwork(identity("two")).pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (error) => error,
          }),
        )
        expect(busy).toMatchObject({ operation: "artwork" })
        yield* provider.releaseArtwork
        expect(yield* Fiber.join(first)).toEqual({ type: "stale" })
        expect(yield* coordinator.artwork(identity("two"))).toEqual({
          type: "available",
          base64: "AQID",
        })
        expect(yield* Ref.get(provider.artworkCalls)).toBe(2)
      }).pipe(Effect.provide(graph(provider, 128, 1))),
    ),
  )
})

test("coordinator shutdown interrupts blocked artwork and clears waiters", async () => {
  const provider = await fixture()
  const state = { ...emptyPlayer(), track: track("one"), fetched_at: 1 }
  const identity = {
    id: "one",
    name: "one",
    artists: "Artist",
    album: "Album",
    duration_ms: 10_000,
  }
  await Effect.runPromise(provider.setState(state))
  const scope = await Effect.runPromise(Scope.make())
  try {
    const services = await Effect.runPromise(
      Scope.provide(scope)(Layer.build(graph(provider, 128, 1))),
    )
    const coordinator = Context.get(services, MusicSessionCoordinator)
    await Effect.runPromise(
      provider.setArtworkResult({ type: "available", base64: "AQID" }),
    )
    await Effect.runPromise(provider.blockArtwork)
    const owner = Effect.runPromise(coordinator.artwork(identity))
    await Effect.runPromise(Queue.take(provider.artworkStarts))
    const joined = Effect.runPromise(coordinator.artwork(identity))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await expect(owner).rejects.toMatchObject({ operation: "artwork" })
    await expect(joined).rejects.toMatchObject({ operation: "artwork" })
    expect(await Effect.runPromise(Ref.get(provider.interruptedArtwork))).toBe(
      1,
    )
    expect(await Effect.runPromise(Ref.get(provider.finalizations))).toBe(1)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("state and status replay current values and snapshots publish without sampling", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        const initial = yield* coordinator.states.pipe(
          Stream.take(1),
          Stream.runHead,
        )
        expect(initial._tag).toBe("Some")
        yield* awaitSubscription(provider)
        yield* Latch.await(provider.sampleStarted)
        const beforeSamples = yield* Ref.get(provider.samples)
        const updates = yield* subscribeStates(coordinator)
        yield* provider.emit({
          type: "snapshot",
          state: { ...emptyPlayer(), track: track("new"), fetched_at: 2 },
        })
        expect((yield* Queue.take(updates)).track?.name).toBe("new")
        expect(yield* Ref.get(provider.samples)).toBeLessThanOrEqual(
          beforeSamples + 1,
        )
        expect(
          (yield* coordinator.status.pipe(Stream.take(1), Stream.runHead))._tag,
        ).toBe("Some")
      }).pipe(Effect.provide(graph(provider))),
    ),
  )
})

test("commands are globally FIFO and toggle resolves when dequeued", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* Effect.all([
          coordinator.submit("toggle"),
          coordinator.submit("toggle"),
        ])
        expect(yield* Ref.get(provider.calls)).toEqual([
          { action: "play" },
          { action: "pause" },
        ])
      }).pipe(Effect.provide(graph(provider))),
    ),
  )
})

test("optimistic seek projects over the current provider snapshot", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        const updates = yield* subscribeStates(coordinator)
        yield* provider.emit({
          type: "snapshot",
          state: {
            ...emptyPlayer(),
            track: track("authoritative"),
            progress_ms: 200,
            fetched_at: 2,
          },
        })
        yield* Queue.take(updates)
        yield* coordinator.submit("seek", 30_000)
        const current = yield* coordinator.current()
        expect(current.state.track?.name).toBe("authoritative")
        expect(current.state.progress_ms).toBe(10_000)
      }).pipe(Effect.provide(graph(provider))),
    ),
  )
})

test("atomic sampling claim stales an active ticket before publication", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sampling = yield* Ref.make<SamplingState>({
        active: true,
        pending: false,
        generation: 4,
      })
      expect(yield* claimSampling(sampling)).toBeUndefined()
      expect(yield* Ref.get(sampling)).toEqual({
        active: true,
        pending: true,
        generation: 5,
      })
    }),
  )
})

test("invalidation bursts discard the stale sample and run one catch-up", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        yield* initialSample(provider)
        const updates = yield* subscribeStates(coordinator)
        yield* provider.blockSample
        yield* provider.enqueueSample({
          ...emptyPlayer(),
          track: track("stale"),
          fetched_at: 2,
        })
        yield* invalidation(provider)
        expect(yield* Queue.take(provider.sampleStarts)).toBe(2)
        yield* provider.enqueueSample({
          ...emptyPlayer(),
          track: track("catch-up"),
          fetched_at: 3,
        })
        yield* invalidation(provider)
        yield* invalidation(provider)
        yield* provider.releaseSample
        expect(yield* Queue.take(provider.sampleCompletions)).toBe(2)
        expect(yield* Queue.take(provider.sampleStarts)).toBe(3)
        expect(yield* Queue.take(provider.sampleCompletions)).toBe(3)
        // The trigger is consumed before release, so the stale attempt cannot
        // commit. Exactly one post-subscription publication is the catch-up.
        expect((yield* Queue.take(updates)).track?.name).toBe("catch-up")
        expect(yield* Ref.get(provider.maxSamples)).toBe(1)
      }).pipe(Effect.provide(graph(provider))),
    ),
  )
})

test("samples started before snapshots and commands cannot overwrite authority", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        yield* initialSample(provider)
        const updates = yield* subscribeStates(coordinator)
        yield* provider.blockSample
        yield* provider.enqueueSample({
          ...emptyPlayer(),
          track: track("stale-snapshot"),
          fetched_at: 2,
        })
        yield* invalidation(provider)
        expect(yield* Queue.take(provider.sampleStarts)).toBe(2)
        yield* snapshot(provider, {
          ...emptyPlayer(),
          track: track("authoritative"),
          fetched_at: 3,
        })
        expect((yield* Queue.take(updates)).track?.name).toBe("authoritative")
        yield* provider.releaseSample
        expect(yield* Queue.take(provider.sampleCompletions)).toBe(2)
        expect((yield* coordinator.current()).state.track?.name).toBe(
          "authoritative",
        )

        yield* provider.blockSample
        yield* provider.enqueueSample({
          ...emptyPlayer(),
          track: track("stale-command"),
          fetched_at: 4,
        })
        yield* invalidation(provider)
        expect(yield* Queue.take(provider.sampleStarts)).toBe(3)
        yield* coordinator.submit("play")
        yield* provider.releaseSample
        expect(yield* Queue.take(provider.sampleCompletions)).toBe(3)
        const current = yield* coordinator.current()
        expect(current.state.track?.name).toBe("authoritative")
        expect(current.state.is_playing).toBe(true)
      }).pipe(Effect.provide(graph(provider))),
    ),
  )
})

test("blocked play, pause, and seek project over a newer snapshot", async () => {
  for (const [action, positionMs] of [
    ["play", undefined],
    ["pause", undefined],
    ["seek", 30_000],
  ] as const) {
    const provider = await fixture()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* MusicSessionCoordinator
          yield* awaitSubscription(provider)
          yield* provider.blockTransport
          const command = yield* coordinator
            .submit(action, positionMs)
            .pipe(Effect.forkScoped)
          yield* Queue.take(provider.transportStarts)
          const updates = yield* subscribeStates(coordinator)
          yield* snapshot(provider, {
            ...emptyPlayer(),
            track: track(`newer-${action}`),
            progress_ms: 700,
            fetched_at: 9,
          })
          yield* Queue.take(updates)
          yield* provider.releaseTransport
          yield* Fiber.join(command)
          const current = yield* coordinator.current()
          expect(current.state.track?.name).toBe(`newer-${action}`)
          expect(current.state.progress_ms).toBe(
            action === "seek" ? 10_000 : 700,
          )
          expect(current.state.is_playing).toBe(action === "play")
        }).pipe(Effect.provide(graph(provider))),
      ),
    )
  }
})

test("transport and navigation reconcile at distinct TestClock boundaries", async () => {
  for (const [action, delay] of [
    ["play", 120],
    ["next", 150],
  ] as const) {
    const provider = await fixture()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* MusicSessionCoordinator
          yield* awaitSubscription(provider)
          yield* initialSample(provider)
          const before = yield* Ref.get(provider.samples)
          yield* coordinator.submit(action)
          yield* TestClock.adjust(delay - 1)
          expect(yield* Ref.get(provider.samples)).toBe(before)
          yield* TestClock.adjust(1)
          expect(yield* Ref.get(provider.samples)).toBe(before + 1)
        }).pipe(Effect.provide(graph(provider))),
      ).pipe(Effect.provide(TestClock.layer())),
    )
  }
})

test("provider transport failure is tagged and leaves the FIFO lane live", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        yield* initialSample(provider)
        const beforeRecovery = yield* Ref.get(provider.samples)
        yield* provider.failNextTransport()
        const failed = yield* coordinator.submit("play").pipe(
          Effect.match({
            onSuccess: () => "success",
            onFailure: (error) => error.code,
          }),
        )
        expect(failed).toBe("PROVIDER_FAILURE")
        expect(yield* Queue.take(provider.sampleStarts)).toBe(
          beforeRecovery + 1,
        )
        yield* coordinator.submit("pause")
        expect(yield* Ref.get(provider.calls)).toEqual([
          { action: "play" },
          { action: "pause" },
        ])
      }).pipe(Effect.provide(graph(provider))),
    ),
  )
})

test("next advances authority without inventing state", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        const updates = yield* subscribeStates(coordinator)
        yield* snapshot(provider, {
          ...emptyPlayer(),
          track: track("current"),
          progress_ms: 55,
        })
        yield* Queue.take(updates)
        const before = yield* coordinator.current()
        yield* coordinator.submit("next")
        const after = yield* coordinator.current()
        expect(after.revision).toBe(before.revision + 1)
        expect(after.state).toEqual(before.state)
      }).pipe(Effect.provide(graph(provider))),
    ),
  )
})

test("scope closure interrupts a blocked sample and finalizes the event source", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        yield* Scope.provide(scope)(Layer.build(graph(provider)))
        yield* awaitSubscription(provider)
        yield* initialSample(provider)
        yield* provider.blockSample
        yield* invalidation(provider)
        yield* Queue.take(provider.sampleStarts)
        yield* Scope.close(scope, Exit.void)
        const samplesAtClose = yield* Ref.get(provider.samples)
        // The closed fixture discards late source traffic; releasing an
        // interrupted provider call cannot revive coordinator work.
        yield* provider.releaseSample
        yield* snapshot(provider, {
          ...emptyPlayer(),
          track: track("late-after-close"),
        })
        expect(yield* Ref.get(provider.samples)).toBe(samplesAtClose)
        expect(yield* Ref.get(provider.interruptedSamples)).toBe(1)
        expect(yield* Ref.get(provider.eventFinalizations)).toBe(1)
        expect(yield* Ref.get(provider.finalizations)).toBe(1)
      }),
    ),
  )
})

test("queue capacity bounds admission and the FIFO worker continues", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        yield* provider.blockTransport
        const first = yield* coordinator.submit("play").pipe(Effect.forkScoped)
        yield* Queue.take(provider.transportStarts)
        const outcomes = yield* Queue.unbounded<{
          readonly action: "pause" | "seek"
          readonly outcome: Result.Result<unknown, { readonly code: string }>
        }>()
        const submit = (action: "pause" | "seek", positionMs?: number) =>
          coordinator.submit(action, positionMs).pipe(
            Effect.result,
            Effect.tap((outcome) => Queue.offer(outcomes, { action, outcome })),
            Effect.forkScoped,
          )
        yield* submit("pause")
        yield* submit("seek", 9)
        // No queued action can settle while play owns the worker. The first
        // result is therefore the overflow, proving its peer was enrolled.
        const overflow = yield* Queue.take(outcomes)
        expect(
          overflow.outcome._tag === "Failure"
            ? overflow.outcome.failure.code
            : "success",
        ).toBe("SERVER_BUSY")
        yield* provider.releaseTransport
        yield* Fiber.join(first)
        const enrolled = yield* Queue.take(outcomes)
        expect(enrolled.outcome._tag).toBe("Success")
        expect(yield* Ref.get(provider.calls)).toEqual([
          { action: "play" },
          { action: enrolled.action },
        ])
        yield* coordinator.submit("next")
        expect(yield* Ref.get(provider.calls)).toEqual([
          { action: "play" },
          { action: enrolled.action },
          { action: "next" },
        ])
      }).pipe(Effect.provide(graph(provider, 1))),
    ),
  )
})

test("scope closure settles active and queued commands exactly once", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const context = yield* Scope.provide(scope)(
          Layer.build(graph(provider, 1)),
        )
        const coordinator = Context.get(context, MusicSessionCoordinator)
        yield* awaitSubscription(provider)
        yield* provider.blockTransport
        const active = yield* coordinator.submit("play").pipe(Effect.forkScoped)
        yield* Queue.take(provider.transportStarts)
        const outcomes = yield* Queue.unbounded<{
          readonly action: "pause" | "next"
          readonly outcome: Result.Result<unknown, { readonly code: string }>
        }>()
        const submit = (action: "pause" | "next") =>
          coordinator.submit(action).pipe(
            Effect.result,
            Effect.tap((outcome) => Queue.offer(outcomes, { action, outcome })),
            Effect.forkScoped,
          )
        yield* submit("pause")
        yield* submit("next")
        // As above, while play is blocked the first completion proves the
        // other submitter crossed enrollment/offer before scope closure.
        const overflow = yield* Queue.take(outcomes)
        expect(
          overflow.outcome._tag === "Failure"
            ? overflow.outcome.failure.code
            : "success",
        ).toBe("SERVER_BUSY")
        yield* Scope.close(scope, Exit.void)
        const settle = (fiber: Fiber.Fiber<unknown, unknown>) =>
          Fiber.join(fiber).pipe(
            Effect.match({
              onSuccess: () => "success",
              onFailure: (error) =>
                error instanceof Error && "code" in error
                  ? String(error.code)
                  : "unknown",
            }),
          )
        expect(yield* settle(active)).toBe("DISPOSED")
        const enrolled = yield* Queue.take(outcomes)
        expect(
          enrolled.outcome._tag === "Failure"
            ? enrolled.outcome.failure.code
            : "success",
        ).toBe("DISPOSED")
        yield* provider.releaseTransport
        expect(yield* Ref.get(provider.calls)).toEqual([{ action: "play" }])
      }),
    ),
  )
})

test("scope close settles a blocked active command and rejects later submissions", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const context = yield* Scope.provide(scope)(
          Layer.build(graph(provider)),
        )
        const coordinator = Context.get(context, MusicSessionCoordinator)
        yield* awaitSubscription(provider)
        yield* provider.blockTransport
        const active = yield* coordinator.submit("play").pipe(Effect.forkScoped)
        yield* Queue.take(provider.transportStarts)
        yield* Scope.close(scope, Exit.void)
        const settled = yield* Fiber.join(active).pipe(
          Effect.match({
            onSuccess: () => "success",
            onFailure: (error) =>
              error instanceof Error && "code" in error
                ? String(error.code)
                : "unknown",
          }),
        )
        expect(settled).toBe("DISPOSED")
        const revisionAtClose = (yield* coordinator.current()).revision
        yield* provider.releaseTransport
        expect((yield* coordinator.current()).revision).toBe(revisionAtClose)
        expect(yield* Ref.get(provider.calls)).toEqual([{ action: "play" }])
        const afterClose = yield* coordinator.submit("next").pipe(Effect.flip)
        expect(afterClose.code).toBe("DISPOSED")
      }),
    ),
  )
})

test("identical paused sample preserves its authority revision", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        yield* initialSample(provider)
        const updates = yield* subscribeStates(coordinator)
        const paused = {
          ...emptyPlayer(),
          track: track("same"),
          fetched_at: 7,
        }
        yield* provider.setState(paused)
        yield* snapshot(provider, paused)
        yield* Queue.take(updates)
        const before = yield* coordinator.current()
        yield* invalidation(provider)
        yield* Queue.take(provider.sampleStarts)
        yield* Queue.take(provider.sampleCompletions)
        expect((yield* coordinator.current()).revision).toBe(before.revision)
      }).pipe(Effect.provide(graph(provider))),
    ),
  )
})

test("a no-op sample preserves the pending poll deadline", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        yield* initialSample(provider)
        const paused = { ...emptyPlayer(), track: track("same"), fetched_at: 7 }
        yield* snapshot(provider, paused)
        yield* TestClock.adjust("4 seconds")
        const before = yield* Ref.get(provider.samples)
        yield* provider.setState(paused)
        yield* invalidation(provider)
        yield* Queue.take(provider.sampleStarts)
        yield* Queue.take(provider.sampleCompletions)
        yield* TestClock.adjust("999 millis")
        expect(yield* Ref.get(provider.samples)).toBe(before + 1)
        yield* TestClock.adjust("1 milli")
        expect(yield* Ref.get(provider.samples)).toBe(before + 2)
        void coordinator
      }).pipe(Effect.provide(graph(provider))),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test("scope closure interrupts poll and reconciliation sleeps", async () => {
  for (const action of [undefined, "play"] as const) {
    const provider = await fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const context = yield* Scope.provide(scope)(
          Layer.build(graph(provider)),
        )
        const coordinator = Context.get(context, MusicSessionCoordinator)
        yield* awaitSubscription(provider)
        yield* initialSample(provider)
        if (action) yield* coordinator.submit(action)
        const samplesAtClose = yield* Ref.get(provider.samples)
        yield* Scope.close(scope, Exit.void)
        yield* TestClock.adjust("10 seconds")
        expect(yield* Ref.get(provider.samples)).toBe(samplesAtClose)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  }
})

test("stale poll candidate cannot attach after newer deadline installs", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deadlines = yield* Ref.make<PollDeadline>({
          revision: 0,
          fiber: undefined,
        })
        const older = yield* reservePollDeadline(deadlines, 1)
        expect(older.reserved).toBe(true)
        const newer = yield* reservePollDeadline(deadlines, 2)
        expect(newer.reserved).toBe(true)
        const newerFiber = yield* Effect.never.pipe(Effect.forkScoped)
        expect(yield* attachPollDeadline(deadlines, 2, newerFiber)).toBe(true)
        const olderFiber = yield* Effect.never.pipe(Effect.forkScoped)
        expect(yield* attachPollDeadline(deadlines, 1, olderFiber)).toBe(false)
        yield* Fiber.interrupt(olderFiber)
        const installed = yield* Ref.get(deadlines)
        expect(installed.revision).toBe(2)
        expect(installed.fiber).toBe(newerFiber)
      }),
    ),
  )
})

test("stale poll-deadline reservation cannot replace newer authority", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const deadlines = yield* Ref.make<PollDeadline>({
        revision: 2,
        fiber: undefined,
      })
      const stale = yield* reservePollDeadline(deadlines, 1)
      expect(stale.reserved).toBe(false)
      expect((yield* Ref.get(deadlines)).revision).toBe(2)
      const current = yield* reservePollDeadline(deadlines, 3)
      expect(current.reserved).toBe(true)
      expect((yield* Ref.get(deadlines)).revision).toBe(3)
    }),
  )
})

test("a newer authority revision owns the only poll deadline", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        const updates = yield* subscribeStates(coordinator)
        const paused = { ...emptyPlayer(), track: track("paused") }
        const playing = { ...paused, is_playing: true }
        yield* provider.setState(playing)
        yield* snapshot(provider, paused)
        yield* Queue.take(updates)
        yield* snapshot(provider, playing)
        yield* Queue.take(updates)
        const before = yield* Ref.get(provider.samples)
        yield* TestClock.adjust("3 seconds")
        expect(yield* Ref.get(provider.samples)).toBe(before + 1)
        // The old paused (five-second) candidate must never fire.
        yield* TestClock.adjust("2 seconds")
        expect(yield* Ref.get(provider.samples)).toBe(before + 1)
        void coordinator
      }).pipe(Effect.provide(graph(provider))),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test("an authoritative snapshot resets the pending poll deadline", async () => {
  const provider = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* awaitSubscription(provider)
        const updates = yield* subscribeStates(coordinator)
        yield* snapshot(provider, { ...emptyPlayer(), track: track("paused") })
        yield* Queue.take(updates)
        const before = yield* Ref.get(provider.samples)
        yield* TestClock.adjust("4999 millis")
        expect(yield* Ref.get(provider.samples)).toBe(before)
        yield* snapshot(provider, {
          ...emptyPlayer(),
          is_playing: true,
          track: track("playing"),
        })
        yield* Queue.take(updates)
        yield* TestClock.adjust("2999 millis")
        expect(yield* Ref.get(provider.samples)).toBe(before)
        yield* TestClock.adjust("1 milli")
        expect(yield* Ref.get(provider.samples)).toBe(before + 1)
        void coordinator
      }).pipe(Effect.provide(graph(provider))),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test("Effect clock polls playing, paused, and idle authority", async () => {
  for (const [state, delay] of [
    [
      { ...emptyPlayer(), is_playing: true, track: track("playing") },
      "3 seconds",
    ],
    [{ ...emptyPlayer(), track: track("paused") }, "5 seconds"],
    [emptyPlayer(), "8 seconds"],
  ] as const) {
    const provider = await fixture()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* MusicSessionCoordinator
          yield* awaitSubscription(provider)
          const updates = yield* subscribeStates(coordinator)
          yield* provider.emit({ type: "snapshot", state })
          yield* Queue.take(updates)
          const before = yield* Ref.get(provider.samples)
          yield* TestClock.adjust(
            delay === "3 seconds"
              ? "2999 millis"
              : delay === "5 seconds"
                ? "4999 millis"
                : "7999 millis",
          )
          expect(yield* Ref.get(provider.samples)).toBe(before)
          yield* TestClock.adjust("1 milli")
          expect(yield* Ref.get(provider.samples)).toBe(before + 1)
          yield* TestClock.adjust("1 milli")
          expect(yield* Ref.get(provider.samples)).toBe(before + 1)
          void coordinator
        }).pipe(Effect.provide(graph(provider))),
      ).pipe(Effect.provide(TestClock.layer())),
    )
  }
})
