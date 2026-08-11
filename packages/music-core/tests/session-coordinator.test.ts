import { expect, test } from "bun:test"
import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schedule,
  Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { emptyPlayer } from "../types.ts"
import { MusicSessionConfig, layer as configLayer } from "../session/config.ts"
import {
  MusicSessionCoordinator,
  layer as coordinatorLayer,
} from "../session/coordinator.ts"
import { createFakeProvider, layerFromLegacy } from "../session/provider.ts"

test("config layer applies defaults and rejects invalid daemon timing", async () => {
  const defaults = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return (yield* MusicSessionConfig).options
      }).pipe(Effect.provide(configLayer({ socketPath: "/tmp/config.sock" }))),
    ),
  )
  expect(defaults.maxFrameBytes).toBe(64 * 1024)
  expect(defaults.pollMs).toEqual({
    playing: 3_000,
    paused: 5_000,
    idle: 8_000,
  })

  const error = await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        configLayer({
          socketPath: "/tmp/config.sock",
          pollMs: { playing: 3_000, paused: 5_000, idle: 0 },
        }),
      ),
    ).pipe(
      Effect.match({
        onSuccess: () => "unexpected success",
        onFailure: (failure) => failure,
      }),
    ),
  )
  expect(error).toMatchObject({
    _tag: "MusicSession.ConfigError",
    setting: "pollMs.idle",
    operation: "resolve",
  })
})

test("coordinator layer owns one provider subscription and serializes toggles", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({
      socketPath: "/tmp/test.sock",
      pollMs: { playing: 100000, paused: 100000, idle: 100000 },
    }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* Effect.all([
          coordinator.submit("toggle"),
          coordinator.submit("toggle"),
        ])
        expect(provider.calls).toEqual(["play", "pause"])
        const replay = yield* coordinator.states.pipe(
          Stream.take(1),
          Stream.runCollect,
        )
        expect(replay).toHaveLength(1)
      }).pipe(Effect.provide(graph)),
    ),
  )
  expect(provider.counts.subscriptions).toBe(1)
  expect(provider.counts.disposals).toBe(1)
  expect(provider.counts.providerDisposals).toBe(1)
})

test("provider snapshots publish immediately without sampling", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({ socketPath: "/tmp/snapshot.sock" }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        const observed = yield* coordinator.states.pipe(
          Stream.filter((snapshot) => snapshot.state.fetched_at === 2),
          Stream.runHead,
          Effect.forkScoped,
        )
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        expect(provider.counts.subscriptions).toBe(1)
        provider.emit({
          type: "snapshot",
          state: { ...provider.state, fetched_at: 2 },
        })
        const snapshot = yield* Fiber.join(observed)
        expect(Option.isSome(snapshot)).toBe(true)
        if (Option.isSome(snapshot))
          expect(snapshot.value.state.fetched_at).toBe(2)
        expect(provider.counts.samples).toBe(1)
      }).pipe(Effect.provide(graph)),
    ),
  )
})

test("atomic sampling claim discards a blocked stale sample and coalesces invalidation bursts", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({ socketPath: "/tmp/stale-sample.sock" }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* MusicSessionCoordinator
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        provider.blockSample()
        provider.emit({ type: "invalidation", reason: "stream-terminated" })
        provider.emit({ type: "invalidation", reason: "stream-terminated" })
        provider.emit({ type: "invalidation", reason: "stream-terminated" })
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        expect(provider.counts.samples).toBe(2)
        provider.releaseSample()
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        expect(provider.counts.samples).toBe(3)
      }).pipe(Effect.provide(graph)),
    ),
  )
})

test("a complete snapshot prevents a blocked older sample from publishing", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({ socketPath: "/tmp/snapshot-authority.sock" }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        provider.blockSample()
        provider.emit({ type: "invalidation", reason: "stream-terminated" })
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        const observed = yield* coordinator.states.pipe(
          Stream.filter((snapshot) => snapshot.state.fetched_at === 2),
          Stream.runHead,
          Effect.forkScoped,
        )
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        provider.emit({
          type: "snapshot",
          state: { ...provider.state, fetched_at: 2 },
        })
        const snapshot = yield* Fiber.join(observed)
        expect(Option.isSome(snapshot)).toBe(true)
        provider.releaseSample()
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        expect((yield* coordinator.current()).state.fetched_at).toBe(2)
        expect(provider.counts.samples).toBe(2)
      }).pipe(Effect.provide(graph)),
    ),
  )
})

test("successful navigation prevents a pre-command sample from publishing", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({ socketPath: "/tmp/navigation-authority.sock" }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        const before = yield* coordinator.current()
        provider.blockSample()
        provider.emit({ type: "invalidation", reason: "stream-terminated" })
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        yield* coordinator.submit("next")
        provider.releaseSample()
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        // Navigation advances authority without inventing a replacement state;
        // releasing the older sample cannot advance it again.
        expect((yield* coordinator.current()).revision).toBe(
          before.revision + 1,
        )
        expect(provider.calls).toEqual(["next"])
      }).pipe(Effect.provide(graph)),
    ),
  )
})

test("queue saturation returns SERVER_BUSY without stopping queued commands", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({
      socketPath: "/tmp/command-capacity.sock",
      commandQueueCapacity: 1,
    }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        provider.blockTransport()
        const first = yield* coordinator.submit("play").pipe(Effect.forkScoped)
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        const second = yield* coordinator
          .submit("pause")
          .pipe(Effect.forkScoped)
        yield* Effect.repeat(Effect.yieldNow, Schedule.recurs(10))
        const rejected = yield* coordinator.submit("next").pipe(
          Effect.match({
            onSuccess: () => "unexpected success",
            onFailure: (error) => error.code,
          }),
        )
        expect(rejected).toBe("SERVER_BUSY")
        provider.releaseTransport()
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(provider.calls).toEqual(["play", "pause"])
      }).pipe(Effect.provide(graph)),
    ),
  )
})

test("reconciliation waits for the configured Effect-time delay", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({
      socketPath: "/tmp/reconciliation.sock",
      reconciliationMs: { transport: 250, navigation: 500 },
      pollMs: { playing: 100_000, paused: 100_000, idle: 100_000 },
    }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        yield* coordinator.submit("play")
        yield* Effect.yieldNow
        yield* TestClock.adjust("249 millis")
        expect(provider.counts.samples).toBe(1)
        yield* TestClock.adjust("1 millis")
        expect(provider.counts.samples).toBe(2)
      }).pipe(Effect.provide(graph)),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test("playing polling advances under TestClock", async () => {
  const provider = createFakeProvider({
    ...emptyPlayer(),
    is_playing: true,
    fetched_at: 1,
    track: {
      id: "track",
      name: "Track",
      artists: "Artist",
      album: "Album",
      uri: "spotify:track:track",
      duration_ms: 10_000,
    },
  })
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({ socketPath: "/tmp/test-clock.sock" }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* MusicSessionCoordinator
        expect(provider.counts.samples).toBe(1)
        yield* TestClock.adjust("3 seconds")
        expect(provider.counts.samples).toBe(2)
      }).pipe(Effect.provide(graph)),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test("TestClock uses paused and idle polling bounds", async () => {
  const paused = createFakeProvider({
    ...emptyPlayer(),
    fetched_at: 1,
    track: {
      id: "paused",
      name: "Paused",
      artists: "Artist",
      album: "Album",
      uri: "spotify:track:paused",
      duration_ms: 10_000,
    },
  })
  const idle = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  const run = (
    provider: ReturnType<typeof createFakeProvider>,
    delay: Duration.Input,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* MusicSessionCoordinator
        expect(provider.counts.samples).toBe(1)
        yield* TestClock.adjust(delay)
        expect(provider.counts.samples).toBe(2)
      }).pipe(
        Effect.provide(
          Layer.provide(
            Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
            configLayer({ socketPath: `/tmp/${delay}.sock` }),
          ),
        ),
      ),
    )
  await Effect.runPromise(
    run(paused, "5 seconds").pipe(Effect.provide(TestClock.layer())),
  )
  await Effect.runPromise(
    run(idle, "8 seconds").pipe(Effect.provide(TestClock.layer())),
  )
})

test("failed and null polls install the next idle deadline", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({ socketPath: "/tmp/failed-poll.sock" }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* MusicSessionCoordinator
        provider.failNextSample()
        yield* TestClock.adjust("8 seconds")
        expect(provider.counts.samples).toBe(2)
        yield* TestClock.adjust("8 seconds")
        expect(provider.counts.samples).toBe(3)
        provider.returnNullNextSample()
        yield* TestClock.adjust("8 seconds")
        expect(provider.counts.samples).toBe(4)
        yield* TestClock.adjust("8 seconds")
        expect(provider.counts.samples).toBe(5)
      }).pipe(Effect.provide(graph)),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test("an authoritative snapshot resets the polling deadline", async () => {
  const provider = createFakeProvider({
    ...emptyPlayer(),
    is_playing: true,
    fetched_at: 1,
    track: {
      id: "reset",
      name: "Reset",
      artists: "Artist",
      album: "Album",
      uri: "spotify:track:reset",
      duration_ms: 10_000,
    },
  })
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({ socketPath: "/tmp/reset-poll.sock" }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* MusicSessionCoordinator
        yield* TestClock.adjust("2 seconds")
        provider.emit({
          type: "snapshot",
          state: { ...provider.state, fetched_at: 2 },
        })
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        expect(provider.counts.samples).toBe(1)
        yield* TestClock.adjust("2 seconds")
        expect(provider.counts.samples).toBe(2)
      }).pipe(Effect.provide(graph)),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test("scope close settles a blocked transport and finalizes the provider once", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  provider.blockTransport()
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({ socketPath: "/tmp/blocked-close.sock" }),
  )
  const scope = await Effect.runPromise(Scope.make())
  try {
    const context = await Effect.runPromise(
      Scope.provide(scope)(Layer.build(graph)),
    )
    const coordinator = Context.get(context, MusicSessionCoordinator)
    const command = Effect.runFork(
      Scope.provide(scope)(coordinator.submit("play")),
    )
    await Effect.runPromise(Effect.repeat(Effect.yieldNow, Schedule.recurs(10)))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    const result = await Effect.runPromise(
      Fiber.join(command).pipe(
        Effect.match({
          onSuccess: () => "unexpected success",
          onFailure: (error) => error.code,
        }),
      ),
    )
    expect(result).toBe("DISPOSED")
    expect(provider.counts.providerDisposals).toBe(1)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("scope close interrupts a blocked initial sample and suppresses its late completion", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  provider.blockSample()
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({ socketPath: "/tmp/blocked-sample-close.sock" }),
  )
  const scope = await Effect.runPromise(Scope.make())
  try {
    const build = Effect.runFork(Scope.provide(scope)(Layer.build(graph)))
    await Effect.runPromise(Effect.repeat(Effect.yieldNow, Schedule.recurs(10)))
    expect(provider.counts.samples).toBe(1)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    provider.releaseSample()
    await Effect.runPromise(Effect.repeat(Effect.yieldNow, Schedule.recurs(10)))
    expect(provider.counts.providerDisposals).toBe(1)
    expect(provider.counts.disposals).toBe(1)
    expect(build.pollUnsafe()).toBeDefined()
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("failed transport returns a tagged failure and leaves the command lane live", async () => {
  const provider = createFakeProvider({ ...emptyPlayer(), fetched_at: 1 })
  provider.failNextTransport()
  const graph = Layer.provide(
    Layer.provide(coordinatorLayer, layerFromLegacy(provider)),
    configLayer({ socketPath: "/tmp/failure.sock" }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* MusicSessionCoordinator
        const failed = yield* coordinator.submit("play").pipe(
          Effect.match({
            onSuccess: () => "unexpected success",
            onFailure: (error) => error.code,
          }),
        )
        expect(failed).toBe("PROVIDER_FAILURE")
        yield* coordinator.submit("play")
        expect(provider.calls).toEqual(["play", "play"])
      }).pipe(Effect.provide(graph)),
    ),
  )
})
