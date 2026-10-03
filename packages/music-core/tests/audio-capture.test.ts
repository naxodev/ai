import { describe, expect, test } from "bun:test"
import {
  Clock,
  Effect,
  Exit,
  Fiber,
  Latch,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import {
  AudioCapture,
  layerFromAdapters,
  makeAudioCapture,
  AudioAdapterError,
  type AudioCaptureAdapter,
} from "../audio/capture.ts"
import { mapAudioClock } from "../audio/clock.ts"
import {
  AUDIO_SAMPLE_AGE_EXPIRY_MS,
  AUDIO_SELECTION_TOKEN_TTL_MS,
  audioFeatureFreshness,
  decodeAudioFeatureFrame,
  MAX_SPECTRUM_BANDS,
  MAX_ENVELOPE_BUCKETS,
  MAX_AUDIO_FEATURE_FRAME_BYTES,
  type AudioFeatureFrame,
  type AudioFeatureDraft,
  type ResolvedCaptureSource,
} from "../audio/schema.ts"
import { readProviderSourceHint } from "../audio/source.ts"
import { createSystemMediaAdapter } from "../system-media.ts"

test("untrusted source hints cannot fabricate a process identity", () => {
  for (const payload of [null, undefined, true, 42, "player", []])
    expect(readProviderSourceHint(payload)).toBeUndefined()

  expect(
    readProviderSourceHint({
      bundleIdentifier: "com.apple.Music",
      parentApplicationBundleIdentifier: null,
      processIdentifier: "42",
    }),
  ).toEqual({ bundleIdentifier: "com.apple.Music" })

  expect(
    readProviderSourceHint({
      bundleIdentifier: "x".repeat(1_025),
      parentApplicationBundleIdentifier: "com.apple.Music",
      processIdentifier: 42,
    }),
  ).toEqual({
    parentBundleIdentifier: "com.apple.Music",
    processIdentifier: 42,
  })
})

const native = (
  pid: number,
  launch = "boot-1",
  object = "tap-1",
): ResolvedCaptureSource => ({
  mode: "process",
  label: "Player",
  observationSequence: 1,
  capabilities: {
    spectrum: "measured",
    envelope: "absent",
    channels: "absent",
  },
  identity: {
    kind: "native",
    processIdentifier: pid,
    launchIdentity: launch,
    executableIdentity: "player-bin",
    coreAudioObject: object,
  },
})

const waiting = <A>(queue: Queue.Dequeue<A>) =>
  Stream.unfold(undefined, () =>
    Queue.take(queue).pipe(Effect.map((item) => [item, undefined] as const)),
  )

const draft = (timestampMs = 1_000): AudioFeatureDraft => ({
  timestampMs,
  sampleAgeMs: 0,
  clockDomain: "capture-monotonic",
  spectrum: [0],
})

/**
 * The adapter registers cleanup before the interruptible readiness wait.
 * acquireRelease acquisition is uninterruptible and must not contain that wait.
 */
const openAdapter = () =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0)
    const releases = yield* Ref.make(0)
    const entered = yield* Latch.make(false)
    const releaseStart = yield* Latch.make(false)
    const frames = yield* Queue.unbounded<AudioFeatureDraft>()
    const adapter: AudioCaptureAdapter = {
      availability: "available",
      start: () =>
        Effect.gen(function* () {
          yield* Ref.update(starts, (count) => count + 1)
          yield* Effect.addFinalizer(() =>
            Ref.update(releases, (count) => count + 1),
          )
          yield* Latch.open(entered)
          yield* Latch.await(releaseStart)
          return { frames: waiting(frames) }
        }),
    }
    return { adapter, starts, releases, entered, releaseStart, frames }
  })

const provideCapture = <A, E, R>(
  effect: Effect.Effect<A, E, R | AudioCapture>,
  adapter: AudioCaptureAdapter,
  sources: ReadonlyArray<ResolvedCaptureSource>,
  extras?: {
    readonly revalidate?: (
      source: ResolvedCaptureSource,
    ) => Effect.Effect<ResolvedCaptureSource | undefined>
    readonly confirm?: () => Effect.Effect<"same" | "changed" | "unresolved">
    readonly observations?: Stream.Stream<
      import("../audio/source.ts").ProviderSourceObservation
    >
    readonly clock?: Clock.Clock
    readonly nowMs?: () => number
  },
) =>
  effect.pipe(
    Effect.provide(
      layerFromAdapters({
        daemonInstanceId: "daemon-a",
        ...(extras?.nowMs ? { nowMs: extras.nowMs } : {}),
        adapter,
        observations: extras?.observations ?? Stream.never,
        resolver: {
          list: () => Effect.succeed({ availability: "available", sources }),
          revalidate: (source) =>
            extras?.revalidate?.(source) ?? Effect.succeed(source),
          confirm: () => extras?.confirm?.() ?? Effect.succeed("same"),
        },
      }),
    ),
    extras?.clock
      ? Effect.provideService(Clock.Clock, extras.clock)
      : (value) => value,
    Effect.scoped,
  )

describe("offline audio capture ownership", () => {
  for (const closeOwner of [false, true]) {
    test(`blocked release fences ${closeOwner ? "owner close" : "a concurrent Start"} during acquisition`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* Scope.make()
            const entered = yield* Latch.make(false)
            const ready = yield* Latch.make(false)
            const closing = yield* Latch.make(false)
            const release = yield* Latch.make(false)
            const starts = yield* Ref.make(0)
            const releases = yield* Ref.make(0)
            const revalidated = yield* Latch.make(false)
            const capture = yield* Scope.provide(owner)(
              makeAudioCapture({
                daemonInstanceId: "daemon-a",
                observations: Stream.never,
                resolver: {
                  list: () =>
                    Effect.succeed({
                      availability: "available",
                      sources: [native(42)],
                    }),
                  revalidate: () =>
                    Latch.open(revalidated).pipe(Effect.as(native(42))),
                  confirm: () => Effect.succeed("same"),
                },
                adapter: {
                  availability: "available",
                  start: () =>
                    Effect.gen(function* () {
                      yield* Ref.update(starts, (n) => n + 1)
                      yield* Effect.addFinalizer(() =>
                        Latch.open(closing).pipe(
                          Effect.andThen(Latch.await(release)),
                          Effect.andThen(Ref.update(releases, (n) => n + 1)),
                        ),
                      )
                      yield* Latch.open(entered)
                      yield* Latch.await(ready)
                      return { frames: Stream.never }
                    }),
                },
              }),
            )
            const listed = yield* capture.listSources("a")
            const token = listed.sources[0]?.token
            if (!token) throw new Error("missing token")
            const starting = yield* capture
              .start("a", token)
              .pipe(Effect.forkChild)
            yield* Latch.await(entered)
            const stopping = yield* capture.stop("a").pipe(Effect.forkChild)
            yield* Latch.await(closing)
            yield* Latch.close(revalidated)
            const nextList = yield* capture.listSources("b")
            const nextToken = nextList.sources[0]?.token
            if (!nextToken) throw new Error("missing token")
            const next = yield* capture
              .start("b", nextToken)
              .pipe(Effect.forkChild)
            yield* Latch.await(revalidated)
            const closed = closeOwner
              ? yield* Scope.close(owner, Exit.void).pipe(Effect.forkChild)
              : undefined
            yield* Effect.yieldNow
            expect(closed?.pollUnsafe()).toBeUndefined()
            expect(next.pollUnsafe()).toBeUndefined()
            expect(yield* Ref.get(starts)).toBe(1)
            expect(yield* Ref.get(releases)).toBe(0)
            expect((yield* capture.status()).type).toBe("acquiring")
            yield* Latch.open(release)
            yield* Latch.open(ready)
            expect(yield* Fiber.join(starting)).toEqual({
              type: "rejected",
              reason: "canceled",
            })
            yield* Fiber.join(stopping)
            const nextResult = yield* Fiber.join(next)
            if (closed) {
              yield* Fiber.join(closed)
              expect(nextResult.type).toBe("rejected")
              expect(yield* Ref.get(releases)).toBe(1)
            } else {
              expect(nextResult.type).toBe("started")
              expect(yield* Ref.get(starts)).toBe(2)
            }
            yield* Scope.close(owner, Exit.void)
            expect(yield* Ref.get(releases)).toBe(closeOwner ? 1 : 2)
          }),
        ),
      )
    })
  }

  test("shared cleanup failure settles Start, Stop, and owner close without admitting another helper", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* Scope.make()
          const entered = yield* Latch.make(false)
          const closing = yield* Latch.make(false)
          const release = yield* Latch.make(false)
          const releases = yield* Ref.make(0)
          const capture = yield* Scope.provide(owner)(
            makeAudioCapture({
              daemonInstanceId: "daemon-a",
              observations: Stream.never,
              resolver: {
                list: () =>
                  Effect.succeed({
                    availability: "available",
                    sources: [native(42)],
                  }),
                revalidate: (current) => Effect.succeed(current),
                confirm: () => Effect.succeed("same"),
              },
              adapter: {
                availability: "available",
                start: () =>
                  Effect.gen(function* () {
                    yield* Effect.addFinalizer(() =>
                      Latch.open(closing).pipe(
                        Effect.andThen(Latch.await(release)),
                        Effect.andThen(Ref.update(releases, (n) => n + 1)),
                        Effect.andThen(
                          Effect.die(new Error("fixture release failed")),
                        ),
                      ),
                    )
                    yield* Latch.open(entered)
                    return yield* Effect.never
                  }),
              },
            }),
          )
          const token = (yield* capture.listSources("a")).sources[0]?.token
          if (!token) throw new Error("missing token")
          const starting = yield* capture
            .start("a", token)
            .pipe(Effect.exit, Effect.forkChild)
          yield* Latch.await(entered)
          const stopping = yield* capture
            .stop("a")
            .pipe(Effect.exit, Effect.forkChild)
          yield* Latch.await(closing)
          const closed = yield* Scope.close(owner, Exit.void).pipe(
            Effect.exit,
            Effect.forkChild,
          )
          yield* Effect.yieldNow
          expect(closed.pollUnsafe()).toBeUndefined()
          yield* Latch.open(release)
          yield* Fiber.join(starting)
          expect(Exit.isFailure(yield* Fiber.join(stopping))).toBe(true)
          expect(Exit.isFailure(yield* Fiber.join(closed))).toBe(true)
          expect(yield* Ref.get(releases)).toBe(1)
          expect((yield* capture.status()).type).toBe("failed")
        }),
      ),
    )
  })

  for (const failure of [false, true]) {
    test(`${failure ? "typed stream failure" : "EOF"} joins release before reporting stopped`, async () => {
      const finish = Latch.makeUnsafe()
      const closing = Latch.makeUnsafe()
      const release = Latch.makeUnsafe()
      const releases = Ref.makeUnsafe(0)
      await Effect.runPromise(
        provideCapture(
          Effect.gen(function* () {
            const capture = yield* AudioCapture
            const statuses =
              yield* Queue.unbounded<
                import("../audio/schema.ts").AudioCaptureStatus
              >()
            yield* capture.subscribeStatus("a").pipe(
              Stream.runForEach((s) => Queue.offer(statuses, s)),
              Effect.forkScoped,
            )
            const listed = yield* capture.listSources("a")
            const token = listed.sources[0]?.token
            if (!token) throw new Error("missing token")
            yield* capture.start("a", token)
            yield* Latch.open(finish)
            yield* Latch.await(closing)
            expect(yield* Ref.get(releases)).toBe(0)
            expect((yield* capture.status()).type).toBe("active")
            yield* Latch.open(release)
            let status = yield* Queue.take(statuses)
            while (status.type !== "stopped")
              status = yield* Queue.take(statuses)
            expect(status.reason).toBe("source-loss")
            expect(yield* Ref.get(releases)).toBe(1)
          }),
          {
            availability: "available",
            start: () =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Latch.open(closing).pipe(
                    Effect.andThen(Latch.await(release)),
                    Effect.andThen(Ref.update(releases, (n) => n + 1)),
                  ),
                )
                return {
                  frames: Stream.fromEffect(Latch.await(finish)).pipe(
                    Stream.drain,
                    Stream.concat(
                      failure
                        ? Stream.fail(
                            new AudioAdapterError({ reason: "setup" }),
                          )
                        : Stream.empty,
                    ),
                  ),
                }
              }),
          },
          [native(42)],
        ),
      )
    })
  }

  test("20 Hz cadence conflates a 10,000-frame burst and cancels pending work on Stop/restart", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          const input = yield* Queue.unbounded<
            AudioFeatureDraft | Latch.Latch
          >()
          const consumed = yield* Latch.make(false)
          const adapter: AudioCaptureAdapter = {
            availability: "available",
            start: () =>
              Effect.succeed({
                frames: waiting(input).pipe(
                  Stream.flatMap((item) =>
                    "spectrum" in item
                      ? Stream.make(item)
                      : Stream.fromEffect(Latch.open(item)).pipe(Stream.drain),
                  ),
                ),
              }),
          }
          yield* provideCapture(
            Effect.gen(function* () {
              const capture = yield* AudioCapture
              const output = yield* Queue.unbounded<AudioFeatureFrame>()
              yield* capture.subscribeFeatures("a").pipe(
                Stream.runForEach((frame) => Queue.offer(output, frame)),
                Effect.forkScoped,
              )
              const start = Effect.gen(function* () {
                const listed = yield* capture.listSources("a")
                const token = listed.sources[0]?.token
                if (!token) throw new Error("missing token")
                return yield* capture.start("a", token)
              })
              yield* start
              for (let i = 1; i <= 10_000; i++)
                yield* Queue.offer(input, { ...draft(0), spectrum: [i] })
              yield* Queue.offer(input, consumed)
              yield* Latch.await(consumed)
              expect((yield* Queue.take(output)).spectrum).toEqual([1])
              expect((yield* Queue.poll(output))._tag).toBe("None")
              yield* clock.adjust("49 millis")
              expect((yield* Queue.poll(output))._tag).toBe("None")
              yield* clock.adjust("1 millis")
              const latest = yield* Queue.take(output)
              expect(latest).toMatchObject({
                sequence: 2,
                spectrum: [10_000],
                publishedAtMs: 50,
                sampleAgeMs: 50,
              })
              yield* Latch.close(consumed)
              yield* Queue.offer(input, { ...draft(50), spectrum: [99] })
              yield* Queue.offer(input, consumed)
              yield* Latch.await(consumed)
              yield* capture.stop("a")
              yield* start
              yield* clock.adjust("50 millis")
              expect((yield* Queue.poll(output))._tag).toBe("None")
              yield* Queue.offer(input, { ...draft(100), spectrum: [7] })
              const restarted = yield* Queue.take(output)
              expect(restarted).toMatchObject({
                generation: 2,
                sequence: 1,
                spectrum: [7],
                publishedAtMs: 100,
              })
              yield* Latch.close(consumed)
              yield* Queue.offer(input, { ...draft(100), spectrum: [8] })
              yield* Queue.offer(input, consumed)
              yield* Latch.await(consumed)
              yield* clock.adjust("50 millis")
              expect(yield* Queue.take(output)).toMatchObject({
                generation: 2,
                sequence: 2,
                spectrum: [8],
                publishedAtMs: 150,
              })
              yield* capture.stop("a")
            }),
            adapter,
            [native(42)],
            {
              clock,
              nowMs: () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000,
            },
          )
        }),
      ),
    )
  })

  test("public decoder distinguishes absent data from measured zero and rejects malformed analysis", () => {
    const frame = {
      daemonInstanceId: "daemon-a",
      generation: 1,
      sequence: 1,
      timestampMs: 0,
      publishedAtMs: 0,
      sampleAgeMs: 0,
      clockDomain: "capture-monotonic",
      source: native(42).identity,
      capabilities: {
        spectrum: "measured",
        envelope: "measured",
        channels: "mono",
      },
      spectrum: [0],
      envelope: [{ min: 0, max: 0 }],
      channels: { layout: "mono", rms: [0], peaks: [0] },
    }
    expect(decodeAudioFeatureFrame(frame)._tag).toBe("Success")
    const largest = {
      ...frame,
      spectrum: Array(MAX_SPECTRUM_BANDS).fill(Number.MAX_VALUE),
      envelope: Array(MAX_ENVELOPE_BUCKETS).fill({
        min: -Number.MAX_VALUE,
        max: Number.MAX_VALUE,
      }),
      daemonInstanceId: "x".repeat(512),
      source: {
        ...native(42).identity,
        launchIdentity: "x".repeat(512),
        executableIdentity: "x".repeat(512),
        coreAudioObject: "x".repeat(512),
      },
    }
    expect(
      new TextEncoder().encode(JSON.stringify(largest)).byteLength,
    ).toBeLessThanOrEqual(MAX_AUDIO_FEATURE_FRAME_BYTES)
    expect(decodeAudioFeatureFrame(largest)._tag).toBe("Success")
    const oversized = {
      ...frame,
      spectrum: Array(1_000).fill(Number.MAX_VALUE),
    }
    expect(
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength,
    ).toBeGreaterThan(MAX_AUDIO_FEATURE_FRAME_BYTES)
    expect(decodeAudioFeatureFrame(oversized)._tag).toBe("Failure")
    expect(
      decodeAudioFeatureFrame({
        ...Object.fromEntries(
          Object.entries(frame).filter(
            ([key]) => key !== "envelope" && key !== "channels",
          ),
        ),
        capabilities: {
          spectrum: "absent",
          envelope: "absent",
          channels: "absent",
        },
        spectrum: [],
      })._tag,
    ).toBe("Success")
    expect(
      decodeAudioFeatureFrame({
        ...frame,
        capabilities: { ...frame.capabilities, channels: "stereo" },
        channels: { layout: "stereo", rms: [0, 0], peaks: [0, 0] },
      })._tag,
    ).toBe("Success")
    for (const change of [
      { spectrum: Array(MAX_SPECTRUM_BANDS + 1).fill(0) },
      { spectrum: "not-an-array" },
      { spectrum: [] },
      { spectrum: [NaN] },
      { spectrum: [Infinity] },
      { spectrum: [-1] },
      { envelope: Array(MAX_ENVELOPE_BUCKETS + 1).fill({ min: 0, max: 0 }) },
      { envelope: [{ min: 1, max: 0 }] },
      { envelope: [{ min: 0 }] },
      { envelope: [{ min: -Infinity, max: 0 }] },
      { envelope: [] },
      { envelope: undefined },
      { channels: { layout: "stereo", rms: [0, 0], peaks: [0, 0] } },
      { channels: { layout: "mono", rms: [0, 0], peaks: [0] } },
      { channels: { layout: "mono", rms: [0], peaks: [] } },
      { channels: { layout: "mono", rms: [NaN], peaks: [0] } },
      { channels: undefined },
      { capabilities: { ...frame.capabilities, spectrum: "absent" } },
      { capabilities: { ...frame.capabilities, envelope: "absent" } },
      { capabilities: { ...frame.capabilities, channels: "absent" } },
      { capabilities: { ...frame.capabilities, channels: "stereo" } },
      {
        spectrum: Array(1_000).fill(Number.MAX_VALUE),
        envelope: Array(MAX_ENVELOPE_BUCKETS).fill({
          min: -Number.MAX_VALUE,
          max: Number.MAX_VALUE,
        }),
        daemonInstanceId: "x".repeat(512),
        source: {
          ...native(42).identity,
          launchIdentity: "x".repeat(512),
          executableIdentity: "x".repeat(512),
          coreAudioObject: "x".repeat(512),
        },
      },
    ])
      expect(decodeAudioFeatureFrame({ ...frame, ...change })._tag).toBe(
        "Failure",
      )
  })

  test("a departing acquisition leader cannot cancel another explicitly joined window", async () => {
    const probe = await Effect.runPromise(openAdapter())
    const confirmed = Latch.makeUnsafe()
    await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const a = (yield* capture.listSources("a")).sources[0]?.token
          const b = (yield* capture.listSources("b")).sources[0]?.token
          if (!a || !b) throw new Error("missing token")
          const first = yield* capture.start("a", a).pipe(Effect.forkChild)
          yield* Latch.await(probe.entered)
          yield* Latch.close(confirmed)
          const second = yield* capture.start("b", b).pipe(Effect.forkChild)
          yield* Latch.await(confirmed)
          yield* Effect.yieldNow
          yield* capture.detach("a")
          expect(yield* Fiber.join(first)).toEqual({
            type: "rejected",
            reason: "canceled",
          })
          yield* Latch.open(probe.releaseStart)
          expect((yield* Fiber.join(second)).type).toBe("started")
          expect(yield* Ref.get(probe.starts)).toBe(1)
          expect(yield* Ref.get(probe.releases)).toBe(0)
          yield* capture.detach("b")
          expect(yield* Ref.get(probe.releases)).toBe(1)
        }),
        probe.adapter,
        [native(42)],
        {
          revalidate: (current) =>
            Latch.open(confirmed).pipe(Effect.as(current)),
        },
      ),
    )
  })

  test("unknown, foreign, consumed, and concurrently reused tokens cannot grant another lease", async () => {
    const probe = await Effect.runPromise(openAdapter())
    await Effect.runPromise(Latch.open(probe.releaseStart))
    const entered = Latch.makeUnsafe()
    const resume = Latch.makeUnsafe()
    const validations = Ref.makeUnsafe(0)
    await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const token = (yield* capture.listSources("a")).sources[0]?.token
          if (!token) throw new Error("missing token")
          expect(yield* capture.start("a", "sel_unknown")).toEqual({
            type: "rejected",
            reason: "unknown-token",
          })
          expect(yield* capture.start("b", token)).toEqual({
            type: "rejected",
            reason: "wrong-connection",
          })
          const first = yield* capture.start("a", token).pipe(Effect.forkChild)
          const second = yield* capture.start("a", token).pipe(Effect.forkChild)
          yield* Latch.await(entered)
          yield* Latch.open(resume)
          const results = [yield* Fiber.join(first), yield* Fiber.join(second)]
          expect(results.map((result) => result.type).sort()).toEqual([
            "rejected",
            "started",
          ])
          expect(results).toContainEqual({
            type: "rejected",
            reason: "unknown-token",
          })
          expect(yield* capture.start("a", token)).toEqual({
            type: "rejected",
            reason: "unknown-token",
          })
          expect(yield* Ref.get(probe.starts)).toBe(1)
        }),
        probe.adapter,
        [native(42)],
        {
          revalidate: (current) =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(validations, (n) => n + 1)
              if (count === 2) yield* Latch.open(entered)
              yield* Latch.await(resume)
              return current
            }),
        },
      ),
    )
  })

  test("interrupted final detach still owns blocked cleanup and fences a joining window", async () => {
    const closing = Latch.makeUnsafe()
    const release = Latch.makeUnsafe()
    const starts = Ref.makeUnsafe(0)
    const releases = Ref.makeUnsafe(0)
    await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const a = (yield* capture.listSources("a")).sources[0]?.token
          const b = (yield* capture.listSources("b")).sources[0]?.token
          if (!a || !b) throw new Error("missing token")
          yield* capture.start("a", a)
          const leaving = yield* capture.detach("a").pipe(Effect.forkChild)
          yield* Latch.await(closing)
          const interrupting = yield* Fiber.interrupt(leaving).pipe(
            Effect.forkChild,
          )
          const joining = yield* capture.start("b", b).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(interrupting.pollUnsafe()).toBeUndefined()
          expect(joining.pollUnsafe()).toBeUndefined()
          expect(yield* Ref.get(starts)).toBe(1)
          yield* Latch.open(release)
          yield* Fiber.join(interrupting)
          expect((yield* Fiber.join(joining)).type).toBe("started")
          expect(yield* Ref.get(releases)).toBe(1)
          yield* capture.detach("b")
          expect(yield* Ref.get(releases)).toBe(2)
        }),
        {
          availability: "available",
          start: () =>
            Effect.gen(function* () {
              yield* Ref.update(starts, (n) => n + 1)
              yield* Effect.addFinalizer(() =>
                Latch.open(closing).pipe(
                  Effect.andThen(Latch.await(release)),
                  Effect.andThen(Ref.update(releases, (n) => n + 1)),
                ),
              )
              return { frames: Stream.never }
            }),
        },
        [native(42)],
      ),
    )
  })

  test("listing does not authorize a tap", async () => {
    const probe = await Effect.runPromise(openAdapter())
    const listed = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          return yield* capture.listSources("window-a")
        }),
        probe.adapter,
        [native(10)],
      ),
    )
    expect(listed.availability).toBe("available")
    expect(await Effect.runPromise(Ref.get(probe.starts))).toBe(0)
  })

  test("detach during revalidation cancels before the adapter starts", async () => {
    const probe = await Effect.runPromise(openAdapter())
    const entered = Latch.makeUnsafe()
    const resume = Latch.makeUnsafe()
    const interrupted = Latch.makeUnsafe()
    const result = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const listed = yield* capture.listSources("owner")
          const token = listed.sources[0]?.token
          if (!token) throw new Error("missing token")
          const pending = yield* capture
            .start("owner", token)
            .pipe(Effect.forkChild)
          yield* Latch.await(entered)
          yield* capture.detach("owner")
          yield* Latch.await(interrupted)
          return {
            result: yield* Fiber.join(pending),
            starts: yield* Ref.get(probe.starts),
          }
        }),
        probe.adapter,
        [native(42)],
        {
          revalidate: () =>
            Latch.open(entered).pipe(
              Effect.andThen(Latch.await(resume)),
              Effect.as(native(42)),
              Effect.ensuring(Latch.open(interrupted)),
            ),
        },
      ),
    )
    expect(result.result).toEqual({ type: "rejected", reason: "canceled" })
    expect(result.starts).toBe(0)
  })

  test("a feature subscription without an explicit join receives no frames", async () => {
    const probe = await Effect.runPromise(openAdapter())
    await Effect.runPromise(Latch.open(probe.releaseStart))
    const seen = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const unauthorized = yield* Ref.make(0)
          yield* capture.subscribeFeatures("not-joined").pipe(
            Stream.runForEach(() =>
              Ref.update(unauthorized, (count) => count + 1),
            ),
            Effect.forkScoped,
          )
          const listed = yield* capture.listSources("owner")
          const token = listed.sources[0]?.token
          if (!token) throw new Error("missing token")
          yield* capture.start("owner", token)
          yield* Queue.offer(probe.frames, draft())
          yield* Effect.yieldNow
          const joined = yield* Queue.unbounded<number>()
          yield* capture.subscribeFeatures("owner").pipe(
            Stream.runForEach((frame) => Queue.offer(joined, frame.sequence)),
            Effect.forkScoped,
          )
          yield* Queue.offer(probe.frames, draft(1_050))
          return {
            unauthorized: yield* Ref.get(unauthorized),
            joined: yield* Queue.take(joined),
          }
        }),
        probe.adapter,
        [native(42)],
      ),
    )
    expect(seen.unauthorized).toBe(0)
    expect(seen.joined).toBe(1)
  })

  test("closing the owner scope releases the adapter", async () => {
    const probe = await Effect.runPromise(openAdapter())
    await Effect.runPromise(Latch.open(probe.releaseStart))
    await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const listed = yield* capture.listSources("owner")
          const token = listed.sources[0]?.token
          if (!token) throw new Error("missing token")
          yield* capture.start("owner", token)
        }),
        probe.adapter,
        [native(42)],
      ),
    )
    expect(await Effect.runPromise(Ref.get(probe.releases))).toBe(1)
  })

  test("concurrent starts share one adapter and a conflicting source stays busy", async () => {
    const probe = await Effect.runPromise(openAdapter())
    const observed = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const first = yield* capture.listSources("a")
          const second = yield* capture.listSources("b")
          const tokenA = first.sources[0]?.token
          const tokenB = second.sources[0]?.token
          const other = second.sources[1]?.token
          if (!tokenA || !tokenB || !other) throw new Error("missing token")
          const left = yield* capture.start("a", tokenA).pipe(Effect.forkChild)
          const right = yield* capture.start("b", tokenB).pipe(Effect.forkChild)
          yield* Latch.await(probe.entered)
          const busy = yield* capture.start("b", other)
          yield* Latch.open(probe.releaseStart)
          return {
            left: yield* Fiber.join(left),
            right: yield* Fiber.join(right),
            busy,
            starts: yield* Ref.get(probe.starts),
          }
        }),
        probe.adapter,
        [native(10), native(11, "boot-2", "tap-2")],
      ),
    )
    expect(observed.starts).toBe(1)
    expect(observed.busy).toEqual({ type: "busy" })
    expect([observed.left.type, observed.right.type].sort()).toEqual([
      "started",
      "started",
    ])
  })

  test("stop during acquisition does not let a late helper publish", async () => {
    const probe = await Effect.runPromise(openAdapter())
    const observed = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const listed = yield* capture.listSources("a")
          const token = listed.sources[0]?.token
          if (!token) throw new Error("missing token")
          const starting = yield* capture
            .start("a", token)
            .pipe(Effect.forkChild)
          yield* Latch.await(probe.entered)
          const stopped = yield* capture.stop("a")
          yield* Latch.open(probe.releaseStart)
          return {
            started: yield* Fiber.join(starting),
            stopped,
            status: yield* capture.status(),
            releases: yield* Ref.get(probe.releases),
          }
        }),
        probe.adapter,
        [native(10)],
      ),
    )
    expect(observed.started).toMatchObject({
      type: "rejected",
      reason: "canceled",
    })
    expect(observed.stopped.type).toBe("stopped")
    expect(observed.status.type).not.toBe("active")
    expect(observed.releases).toBe(1)
  })

  test("PID reuse and expired tokens do not authorize capture", async () => {
    const probe = await Effect.runPromise(openAdapter())
    const reused = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const listed = yield* capture.listSources("a")
          const token = listed.sources[0]?.token
          if (!token) throw new Error("missing token")
          return yield* capture.start("a", token)
        }),
        probe.adapter,
        [native(10)],
        { revalidate: () => Effect.succeed(native(10, "boot-2", "tap-2")) },
      ),
    )
    const expired = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          return yield* provideCapture(
            Effect.gen(function* () {
              const capture = yield* AudioCapture
              const listed = yield* capture.listSources("a")
              const token = listed.sources[0]?.token
              if (!token) throw new Error("missing token")
              yield* clock.adjust(`${AUDIO_SELECTION_TOKEN_TTL_MS + 1} millis`)
              return yield* capture.start("a", token)
            }),
            probe.adapter,
            [native(10)],
            { clock },
          )
        }),
      ),
    )
    expect(reused).toEqual({ type: "rejected", reason: "pid-reuse" })
    expect(expired).toEqual({ type: "rejected", reason: "expired-token" })
  })

  test("the last joined connection stops capture and a metadata client does not keep it", async () => {
    const probe = await Effect.runPromise(openAdapter())
    await Effect.runPromise(Latch.open(probe.releaseStart))
    const observed = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const owner = yield* capture.listSources("a")
          const joiner = yield* capture.listSources("b")
          const tokenA = owner.sources[0]?.token
          const tokenB = joiner.sources[0]?.token
          if (!tokenA || !tokenB) throw new Error("missing token")
          yield* capture
            .subscribeStatus("metadata")
            .pipe(Stream.runDrain, Effect.forkScoped)
          yield* capture.start("a", tokenA)
          yield* capture.start("b", tokenB)
          yield* capture.detach("a")
          const still = (yield* capture.status()).type
          yield* capture.detach("metadata")
          const kept = (yield* capture.status()).type
          yield* capture.detach("b")
          return { still, kept, final: (yield* capture.status()).type }
        }),
        probe.adapter,
        [native(10)],
      ),
    )
    expect(observed).toEqual({
      still: "active",
      kept: "active",
      final: "stopped",
    })
  })

  test("now playing invalidation stops capture and does not follow a replacement", async () => {
    const probe = await Effect.runPromise(openAdapter())
    await Effect.runPromise(Latch.open(probe.releaseStart))
    const observations = await Effect.runPromise(
      Queue.unbounded<import("../audio/source.ts").ProviderSourceObservation>(),
    )
    const status = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const listed = yield* capture.listSources("a")
          const token = listed.sources[0]?.token
          if (!token) throw new Error("missing token")
          yield* capture.start("a", token)
          const stopped = yield* capture.subscribeStatus("observer").pipe(
            Stream.filter((status) => status.type === "stopped"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          )
          yield* Queue.offer(observations, {
            sequence: 2,
            kind: "invalidation",
            hint: undefined,
          })
          return (yield* Fiber.join(stopped))[0]
        }),
        probe.adapter,
        [{ ...native(10), mode: "now-playing", label: "Now Playing" }],
        { observations: waiting(observations) },
      ),
    )
    expect(status).toMatchObject({ type: "stopped", reason: "source-loss" })
    expect(await Effect.runPromise(Ref.get(probe.starts))).toBe(1)
  })

  test("an older poll cannot overwrite a newer stream source hint", async () => {
    let releaseRead: (() => void) | undefined
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let emitLine: ((line: string) => void) | undefined
    const media = createSystemMediaAdapter({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async () => {
        await readGate
        return {
          ok: true,
          out: JSON.stringify({
            title: "Old",
            artist: "A",
            album: "B",
            duration: 1,
            elapsedTimeNow: 0,
            playing: true,
            contentItemIdentifier: "1",
            bundleIdentifier: "com.old",
            processIdentifier: 1,
          }),
          err: "",
        }
      },
      startLineStream: (_command, callbacks) => {
        emitLine = (line) => callbacks.onLine(line)
        return () => {}
      },
    })
    media.subscribeAttempt?.(() => {})
    const pending = media.player()
    emitLine?.(
      JSON.stringify({
        type: "data",
        payload: {
          title: "New",
          artist: "A",
          album: "B",
          duration: 1,
          elapsedTimeNow: 0,
          playing: true,
          contentItemIdentifier: "2",
          bundleIdentifier: "com.new",
          processIdentifier: 2,
        },
      }),
    )
    releaseRead?.()
    await pending
    expect(media.latestSourceObservation?.().hint).toEqual({
      bundleIdentifier: "com.new",
      processIdentifier: 2,
    })
    expect(
      readProviderSourceHint({ processIdentifier: 1 })?.processIdentifier,
    ).toBe(1)
  })

  test("queued frame age uses publication time, not local receipt", () => {
    const frame = {
      daemonInstanceId: "daemon-a",
      generation: 1,
      sequence: 1,
      timestampMs: 0,
      publishedAtMs: 0,
      clockDomain: "capture-monotonic" as const,
      sampleAgeMs: 0,
      source: native(10).identity,
      capabilities: native(10).capabilities,
      spectrum: [0],
    }
    expect(
      audioFeatureFreshness({
        frame,
        nowMs: AUDIO_SAMPLE_AGE_EXPIRY_MS + 1,
      }),
    ).toBe("stale")
    expect(audioFeatureFreshness({ frame, nowMs: 100 })).toBe("fresh")
    expect(
      audioFeatureFreshness({
        frame: { ...frame, timestampMs: 500, publishedAtMs: 100 },
        nowMs: 100,
      }),
    ).toBe("stale")
  })

  test("repeated lists prune expired selections", async () => {
    const probe = await Effect.runPromise(openAdapter())
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          return yield* provideCapture(
            Effect.gen(function* () {
              const capture = yield* AudioCapture
              const first = yield* capture.listSources("a")
              const token = first.sources[0]?.token
              if (!token) throw new Error("missing token")
              yield* clock.adjust(`${AUDIO_SELECTION_TOKEN_TTL_MS + 1} millis`)
              yield* capture.listSources("a")
              return yield* capture.start("a", token)
            }),
            probe.adapter,
            [native(10)],
            { clock },
          )
        }),
      ),
    )
    expect(result).toEqual({ type: "rejected", reason: "unknown-token" })
  })

  test("the same feature subscription receives the next generation after Stop", async () => {
    const probe = await Effect.runPromise(openAdapter())
    await Effect.runPromise(Latch.open(probe.releaseStart))
    const seen = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const generations = yield* Queue.unbounded<number>()
          const listed = yield* capture.listSources("a")
          const token = listed.sources[0]?.token
          if (!token) throw new Error("missing token")
          yield* capture.start("a", token)
          yield* capture.subscribeFeatures("a").pipe(
            Stream.runForEach((frame) =>
              Queue.offer(generations, frame.generation),
            ),
            Effect.forkScoped,
          )
          yield* Queue.offer(probe.frames, draft(1_000))
          const first = yield* Queue.take(generations)
          yield* capture.stop("a")
          const again = yield* capture.listSources("a")
          const next = again.sources[0]?.token
          if (!next) throw new Error("missing token")
          yield* capture.start("a", next)
          yield* Queue.offer(probe.frames, draft(2_000))
          const second = yield* Queue.take(generations)
          return [first, second]
        }),
        probe.adapter,
        [native(10)],
      ),
    )
    expect(seen).toEqual([1, 2])
  })

  test("disposing the last feature listener releases capture and one of two does not", async () => {
    const probe = await Effect.runPromise(openAdapter())
    await Effect.runPromise(Latch.open(probe.releaseStart))
    const releases = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const listed = yield* capture.listSources("a")
          const token = listed.sources[0]?.token
          if (!token) throw new Error("missing token")
          const scopeA = yield* Scope.make()
          const scopeB = yield* Scope.make()
          const registeredA = yield* Latch.make(false)
          const registeredB = yield* Latch.make(false)
          yield* Effect.forkIn(scopeA, { startImmediately: true })(
            capture
              .subscribeFeatures("a")
              .pipe(Stream.runForEach(() => Latch.open(registeredA))),
          )
          yield* Effect.forkIn(scopeB, { startImmediately: true })(
            capture
              .subscribeFeatures("a")
              .pipe(Stream.runForEach(() => Latch.open(registeredB))),
          )
          yield* capture.start("a", token)
          yield* Queue.offer(probe.frames, draft(1_000))
          yield* Latch.await(registeredA)
          yield* Latch.await(registeredB)
          yield* Scope.close(scopeA, Exit.void)
          const kept = (yield* capture.status()).type
          yield* Scope.close(scopeB, Exit.void)
          return {
            kept,
            final: (yield* capture.status()).type,
            releases: yield* Ref.get(probe.releases),
          }
        }),
        probe.adapter,
        [native(10)],
        { nowMs: () => 1_000 },
      ),
    )
    expect(releases.kept).toBe("active")
    expect(releases.final).toBe("stopped")
    expect(releases.releases).toBe(1)
  })

  test("a failed ownership check stops capture instead of leaving it unwatched", async () => {
    const probe = await Effect.runPromise(openAdapter())
    await Effect.runPromise(Latch.open(probe.releaseStart))
    const observations = await Effect.runPromise(
      Queue.unbounded<import("../audio/source.ts").ProviderSourceObservation>(),
    )
    const status = await Effect.runPromise(
      provideCapture(
        Effect.gen(function* () {
          const capture = yield* AudioCapture
          const listed = yield* capture.listSources("a")
          const token = listed.sources[0]?.token
          if (!token) throw new Error("missing token")
          yield* capture.start("a", token)
          const stopped = yield* capture.subscribeStatus("observer").pipe(
            Stream.filter((status) => status.type === "stopped"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          )
          yield* Queue.offer(observations, {
            sequence: 3,
            kind: "snapshot",
            hint: { processIdentifier: 99 },
          })
          return (yield* Fiber.join(stopped))[0]
        }),
        probe.adapter,
        [{ ...native(10), mode: "now-playing", label: "Now Playing" }],
        {
          observations: waiting(observations),
          confirm: () => Effect.die(new Error("confirm failed")),
        },
      ),
    )
    expect(status).toMatchObject({ type: "stopped", reason: "source-loss" })
  })

  test("clock mapping expires delayed frames and does not treat receipt as fresh", () => {
    const mapping = mapAudioClock({
      clientSendMs: 10,
      clientReceiveMs: 30,
      daemonSampleMs: 1_000_000,
    })
    const frame = {
      daemonInstanceId: "daemon-a",
      generation: 1,
      sequence: 2,
      timestampMs: 1_000_000,
      publishedAtMs: 1_000_000,
      clockDomain: "capture-monotonic" as const,
      sampleAgeMs: 0,
      source: native(10).identity,
      capabilities: native(10).capabilities,
      spectrum: [0],
    }
    const delayedNow = mapping.daemonNow(10 + AUDIO_SAMPLE_AGE_EXPIRY_MS + 50)
    expect(audioFeatureFreshness({ frame, nowMs: delayedNow })).toBe("stale")
    expect(
      audioFeatureFreshness({
        frame: {
          ...frame,
          timestampMs: delayedNow + 1_000,
          publishedAtMs: delayedNow + 1_000,
        },
        nowMs: delayedNow,
      }),
    ).toBe("stale")
  })
})
