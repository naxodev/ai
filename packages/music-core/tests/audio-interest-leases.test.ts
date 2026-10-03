import { expect, test } from "bun:test"
import { Clock, Effect, Fiber, Latch, Ref, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { makeAudioCapture } from "../audio/capture.ts"
import type { ResolvedCaptureSource } from "../audio/schema.ts"

const source: ResolvedCaptureSource = {
  mode: "process",
  label: "Synthetic player",
  observationSequence: 1,
  identity: {
    kind: "native",
    processIdentifier: 42,
    launchIdentity: "fixture",
    executableIdentity: "fixture",
    coreAudioObject: "fixture",
  },
  capabilities: {
    spectrum: "measured",
    envelope: "absent",
    channels: "absent",
  },
}

const fixture = Effect.gen(function* () {
  const clock = yield* TestClock.make()
  let now = 0
  let nowOverride: (() => number) | undefined
  let onRevalidate: (() => void) | undefined
  const releases = yield* Ref.make(0)
  const starts = yield* Ref.make(0)
  const entered = yield* Latch.make(false)
  const ready = yield* Latch.make(false)
  const closing = yield* Latch.make(false)
  const releaseCleanup = yield* Latch.make(true)
  const capture = yield* makeAudioCapture({
    daemonInstanceId: "lease-test",
    nowMs: () => nowOverride?.() ?? now,
    observations: Stream.never,
    resolver: {
      list: () =>
        Effect.succeed({ availability: "available", sources: [source] }),
      revalidate: (selected) =>
        Effect.sync(() => {
          onRevalidate?.()
          return selected
        }),
      confirm: () => Effect.succeed("same"),
    },
    adapter: {
      availability: "available",
      start: () =>
        Effect.gen(function* () {
          yield* Ref.update(starts, (count) => count + 1)
          yield* Effect.addFinalizer(() =>
            Latch.open(closing).pipe(
              Effect.andThen(Latch.await(releaseCleanup)),
              Effect.andThen(Ref.update(releases, (count) => count + 1)),
            ),
          )
          yield* Latch.open(entered)
          yield* Latch.await(ready)
          return { frames: Stream.never }
        }),
    },
  }).pipe(Effect.provideService(Clock.Clock, clock))
  const select = Effect.fn("LeaseTest.select")(function* (id: string) {
    const listed = yield* capture.listSources(id)
    const token = listed.sources[0]?.token
    if (!token) throw new Error("missing synthetic source")
    return token
  })
  const advance = (ms: number) =>
    Effect.sync(() => {
      now += ms
    }).pipe(Effect.andThen(clock.adjust(`${ms} millis`)))
  return {
    capture,
    releases,
    starts,
    closing,
    releaseCleanup,
    entered,
    ready,
    select,
    advance,
    setNow: (ms: number) =>
      Effect.sync(() => {
        now = ms
      }),
    setRevalidate: (action: () => void) =>
      Effect.sync(() => {
        onRevalidate = action
      }),
    overrideNow: (read: () => number) =>
      Effect.sync(() => {
        nowOverride = read
      }),
  }
})

test("a stalled joined connection expires without disconnecting; metadata cannot keep its capture alive", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Latch.open(f.ready)
        yield* f.capture
          .subscribeStatus("metadata")
          .pipe(Stream.runDrain, Effect.forkScoped)
        const result = yield* f.capture.start(
          "stalled",
          yield* f.select("stalled"),
        )
        expect(result.type).toBe("started")
        const stopped = yield* f.capture.subscribeStatus("metadata").pipe(
          Stream.filter((status) => status.type === "stopped"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* f.advance(5_000)
        expect((yield* Fiber.join(stopped))[0]).toMatchObject({
          type: "stopped",
          reason: "lease-expired",
        })
        expect(yield* Ref.get(f.releases)).toBe(1)
        expect(yield* f.capture.renew("stalled", 1)).toEqual({
          type: "rejected",
          reason: "not-joined",
        })
        expect(yield* f.capture.stop("stalled")).toEqual({
          type: "rejected",
          reason: "not-joined",
        })
        expect(
          (yield* f.capture.start("stalled", yield* f.select("stalled"))).type,
        ).toBe("started")
      }),
    ),
  )
})

test("one expired window loses authority while a healthy join keeps the same capture", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Latch.open(f.ready)
        yield* f.capture.start("stalled", yield* f.select("stalled"))
        expect(
          (yield* f.capture.start("healthy", yield* f.select("healthy"))).type,
        ).toBe("joined")
        yield* f.advance(4_000)
        expect(yield* f.capture.renew("healthy", 1)).toEqual({
          type: "renewed",
          generation: 1,
        })
        const expired = yield* f.capture.subscribeStatus("stalled").pipe(
          Stream.filter((status) => status.type === "stopped"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* f.advance(1_000)
        expect((yield* Fiber.join(expired))[0]).toMatchObject({
          reason: "lease-expired",
        })
        expect((yield* f.capture.status()).type).toBe("active")
        expect(yield* Ref.get(f.releases)).toBe(0)
        expect((yield* f.capture.renew("stalled", 1)).type).toBe("rejected")
        expect((yield* f.capture.stop("stalled")).type).toBe("rejected")
        expect((yield* f.capture.renew("metadata", 1)).type).toBe("rejected")
        expect((yield* f.capture.renew("healthy", 2)).type).toBe("rejected")
        expect((yield* f.capture.stop("healthy")).type).toBe("stopped")
        expect(yield* Ref.get(f.releases)).toBe(1)
      }),
    ),
  )
})

test("renewal after a missed deadline cannot revive authority before the expiry sweep", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Latch.open(f.ready)
        yield* f.capture.start("a", yield* f.select("a"))
        // The deadline is checked by renewal itself, not only by the periodic sweep.
        yield* f.setNow(5_001)
        expect((yield* f.capture.renew("a", 1)).type).toBe("rejected")
        yield* f.advance(250)
        yield* f.capture.start("a", yield* f.select("a"))
        expect((yield* f.capture.renew("a", 1)).type).toBe("rejected")
        expect(yield* f.capture.renew("a", 2)).toEqual({
          type: "renewed",
          generation: 2,
        })
      }),
    ),
  )
})

test("a paused status subscriber receives expiry before another peer's newer capture presentation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Latch.open(f.ready)
        const entered = yield* Latch.make(false)
        const resume = yield* Latch.make(false)
        const newer = yield* Latch.make(false)
        const statuses: unknown[] = []
        yield* f.capture.subscribeStatus("stalled").pipe(
          Stream.runForEach((status) =>
            Effect.gen(function* () {
              statuses.push(status)
              if (status.type === "idle") {
                yield* Latch.open(entered)
                yield* Latch.await(resume)
              }
              if (status.type === "active" && status.generation === 2)
                yield* Latch.open(newer)
            }),
          ),
          Effect.forkScoped,
        )
        yield* Latch.await(entered)
        yield* f.capture.start("stalled", yield* f.select("stalled"))
        yield* f.advance(5_000)
        expect(yield* Ref.get(f.releases)).toBe(1)
        yield* f.capture.start("healthy", yield* f.select("healthy"))
        yield* Latch.open(resume)
        yield* Latch.await(newer)
        expect(statuses).toContainEqual({
          type: "stopped",
          generation: 1,
          reason: "lease-expired",
        })
      }),
    ),
  )
})

test("status overflow ends the slow subscription without blocking capture cleanup or healthy peers", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Latch.open(f.ready)
        const entered = yield* Latch.make(false)
        const resume = yield* Latch.make(false)
        let received = 0
        const slow = yield* f.capture.subscribeStatus("slow").pipe(
          Stream.runForEach(() =>
            Effect.gen(function* () {
              received++
              if (received === 1) {
                yield* Latch.open(entered)
                yield* Latch.await(resume)
              }
            }),
          ),
          Effect.forkScoped,
        )
        yield* Latch.await(entered)
        for (let generation = 1; generation <= 10; generation++) {
          expect(
            yield* f.capture.start("healthy", yield* f.select("healthy")),
          ).toMatchObject({ type: "started", generation })
          yield* f.capture.stop("healthy")
        }
        expect(yield* Ref.get(f.releases)).toBe(10)
        expect(yield* f.capture.status()).toMatchObject({
          type: "stopped",
          generation: 10,
        })
        yield* Latch.open(resume)
        yield* Fiber.join(slow).pipe(Effect.timeout("1 second"))
        expect(received).toBeLessThanOrEqual(17)
      }),
    ),
  )
})

test("revalidation crossing the last lease deadline cannot join or revive that generation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Latch.open(f.ready)
        yield* f.capture.start("a", yield* f.select("a"))
        const token = yield* f.select("b")
        let revalidated = false
        yield* f.overrideNow(() => (revalidated ? 5_001 : 0))
        yield* f.setRevalidate(() => {
          revalidated = true
        })
        const result = yield* f.capture.start("b", token)
        expect(result).toMatchObject({ type: "started", generation: 2 })
        expect(yield* Ref.get(f.releases)).toBe(1)
        expect((yield* f.capture.renew("a", 1)).type).toBe("rejected")
      }),
    ),
  )
})

test("Stop must still own an unexpired lease at the atomic shared-retirement decision", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Latch.open(f.ready)
        yield* f.capture.start("a", yield* f.select("a"))
        yield* f.capture.start("b", yield* f.select("b"))
        yield* f.advance(4_000)
        yield* f.capture.renew("b", 1)
        let reads = 0
        yield* f.overrideNow(() => (++reads === 1 ? 4_999 : 5_000))
        expect(yield* f.capture.stop("a")).toEqual({
          type: "rejected",
          reason: "not-joined",
        })
        expect((yield* f.capture.status()).type).toBe("active")
        expect(yield* Ref.get(f.releases)).toBe(0)
      }),
    ),
  )
})

test("Stop cancels a Start already waiting on expired native cleanup, before another helper can be acquired", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Effect.gen(function* () {
          yield* Latch.open(f.ready)
          yield* f.capture.start("a", yield* f.select("a"))
          yield* f.advance(0)
          const token = yield* f.select("b")
          yield* Latch.close(f.releaseCleanup)
          yield* f.setNow(5_000)
          const starting = yield* f.capture
            .start("b", token)
            .pipe(Effect.forkScoped)
          yield* Latch.await(f.closing)
          expect(yield* f.capture.stop("b")).toEqual({
            type: "rejected",
            reason: "not-joined",
          })
          yield* Latch.open(f.releaseCleanup)
          expect(yield* Fiber.join(starting)).toEqual({
            type: "rejected",
            reason: "canceled",
          })
          expect(yield* Ref.get(f.starts)).toBe(1)
        }).pipe(Effect.ensuring(Latch.open(f.releaseCleanup)))
      }),
    ),
  )
})

test("startup has its own bound; the active lease starts only when acquisition completes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const starting = yield* f.capture
          .start("a", yield* f.select("a"))
          .pipe(Effect.forkScoped)
        yield* Latch.await(f.entered)
        yield* f.advance(6_000)
        expect((yield* f.capture.status()).type).toBe("acquiring")
        yield* Latch.open(f.ready)
        expect((yield* Fiber.join(starting)).type).toBe("started")
        yield* f.advance(4_000)
        expect(yield* f.capture.renew("a", 1)).toEqual({
          type: "renewed",
          generation: 1,
        })
        expect(yield* Ref.get(f.releases)).toBe(0)
      }),
    ),
  )
})

test("expired acquisition cancels its waiter even if a later joined window becomes ready", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const first = yield* f.capture
          .start("a", yield* f.select("a"))
          .pipe(Effect.forkScoped)
        yield* Latch.await(f.entered)
        yield* f.advance(25_000)
        const second = yield* Effect.forkIn(yield* Scope.Scope, {
          startImmediately: true,
        })(f.capture.start("b", yield* f.select("b")))
        yield* f.advance(5_000)
        expect(yield* Fiber.join(first)).toMatchObject({
          type: "rejected",
          reason: "canceled",
        })
        expect(yield* Ref.get(f.releases)).toBe(0)
        yield* Latch.open(f.ready)
        expect((yield* Fiber.join(second)).type).toBe("started")
        expect((yield* f.capture.renew("a", 1)).type).toBe("rejected")
        expect((yield* f.capture.renew("b", 1)).type).toBe("renewed")
      }),
    ),
  )
})
