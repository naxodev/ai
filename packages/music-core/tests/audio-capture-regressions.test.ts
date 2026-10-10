import { expect, test } from "bun:test"
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Fiber,
  Latch,
  Ref,
  Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { AudioAdapterError, makeAudioCapture } from "../audio/capture.ts"
import type { ResolvedCaptureSource } from "../audio/schema.ts"
import type { ProviderSourceObservation } from "../audio/source.ts"
import {
  SessionProvider,
  layerFromAttemptAdapter,
} from "../session/provider.ts"

const source: ResolvedCaptureSource = {
  mode: "process",
  label: "fixture",
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
const resolver = {
  list: () =>
    Effect.succeed({ availability: "available" as const, sources: [source] }),
  revalidate: (selected: ResolvedCaptureSource) => Effect.succeed(selected),
  confirm: () => Effect.succeed("same" as const),
}
const select = (
  capture: Effect.Success<ReturnType<typeof makeAudioCapture>>,
  id: string,
) =>
  capture.listSources(id).pipe(
    Effect.map((list) => {
      const token = list.sources[0]?.token
      if (!token) throw new Error("missing fixture token")
      return token
    }),
  )

const fixture = Effect.gen(function* () {
  const entered = yield* Latch.make(false)
  const ready = yield* Latch.make(false)
  const closing = yield* Latch.make(false)
  const release = yield* Latch.make(true)
  const releases = yield* Ref.make(0)
  const admitted = yield* Latch.make(false)
  const capture = yield* makeAudioCapture({
    daemonInstanceId: "fixture",
    nowMs: () => 0,
    observations: Stream.never,
    resolver: {
      ...resolver,
      revalidate: (selected) => Latch.open(admitted).pipe(Effect.as(selected)),
    },
    adapter: {
      availability: "available",
      start: () =>
        Effect.gen(function* () {
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
  })
  return { capture, entered, ready, closing, release, releases, admitted }
})

test("interrupting the last admitted Start joins cleanup and cannot activate later", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const starting = yield* f.capture
          .start("a", yield* select(f.capture, "a"))
          .pipe(Effect.forkChild)
        yield* Latch.await(f.entered)
        yield* Fiber.interrupt(starting)
        expect(yield* Ref.get(f.releases)).toBe(1)
        expect(yield* f.capture.status()).toMatchObject({ type: "stopped" })
        yield* Latch.open(f.ready)
        expect(
          (yield* f.capture.start("b", yield* select(f.capture, "b"))).type,
        ).toBe("started")
      }),
    ),
  )
})

test("interrupting an acquisition caller preserves another explicitly admitted interest", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const first = yield* f.capture
          .start("a", yield* select(f.capture, "a"))
          .pipe(Effect.forkChild)
        yield* Latch.await(f.entered)
        yield* Latch.close(f.admitted)
        const second = yield* f.capture
          .start("b", yield* select(f.capture, "b"))
          .pipe(Effect.forkChild)
        yield* Latch.await(f.admitted)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(first)
        expect(yield* Ref.get(f.releases)).toBe(0)
        yield* Latch.open(f.ready)
        expect((yield* Fiber.join(second)).type).toBe("started")
        yield* f.capture.detach("b")
        expect(yield* Ref.get(f.releases)).toBe(1)
      }),
    ),
  )
})

test("canceled Start, detach, and concurrent Stop all join the same blocked retirement", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Effect.gen(function* () {
          const starting = yield* f.capture
            .start("a", yield* select(f.capture, "a"))
            .pipe(Effect.forkChild)
          yield* Latch.await(f.entered)
          yield* Latch.close(f.release)
          const stopping = yield* f.capture.stop("a").pipe(Effect.forkChild)
          yield* Latch.await(f.closing)
          const departing = yield* f.capture.detach("a").pipe(Effect.forkChild)
          const again = yield* f.capture.stop("a").pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(starting.pollUnsafe()).toBeUndefined()
          expect(departing.pollUnsafe()).toBeUndefined()
          expect(again.pollUnsafe()).toBeUndefined()
          expect(yield* Ref.get(f.releases)).toBe(0)
          yield* Latch.open(f.release)
          expect(yield* Fiber.join(starting)).toEqual({
            type: "rejected",
            reason: "canceled",
          })
          yield* Fiber.join(stopping)
          yield* Fiber.join(departing)
          yield* Fiber.join(again)
          expect(yield* Ref.get(f.releases)).toBe(1)
        }).pipe(Effect.ensuring(Latch.open(f.release)))
      }),
    ),
  )
})

test("confirmation crossing token expiry never authorizes adapter acquisition", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const observed = yield* Latch.make(false)
        const starts = yield* Ref.make(0)
        const capture = yield* makeAudioCapture({
          daemonInstanceId: "fixture",
          tokenTtlMs: 100,
          nowMs: () => 0,
          observations: Stream.make({
            sequence: 2,
            kind: "snapshot",
            hint: { processIdentifier: 42 },
          } as const).pipe(
            Stream.tap(() => Latch.open(observed)),
            Stream.concat(Stream.never),
          ),
          resolver: {
            ...resolver,
            list: () =>
              Effect.succeed({
                availability: "available",
                sources: [{ ...source, mode: "now-playing" }],
              }),
            confirm: () => clock.adjust("101 millis").pipe(Effect.as("same")),
          },
          adapter: {
            availability: "available",
            start: () =>
              Ref.update(starts, (n) => n + 1).pipe(
                Effect.as({ frames: Stream.never }),
              ),
          },
        }).pipe(Effect.provideService(Clock.Clock, clock))
        yield* Latch.await(observed)
        const token = yield* select(capture, "a").pipe(
          Effect.provideService(Clock.Clock, clock),
        )
        expect(
          yield* capture
            .start("a", token)
            .pipe(Effect.provideService(Clock.Clock, clock)),
        ).toEqual({ type: "rejected", reason: "expired-token" })
        expect(yield* Ref.get(starts)).toBe(0)
      }),
    ),
  )
})

test("real provider observations retain invalidation before a same-source replacement snapshot", async () => {
  let listener: ((o: ProviderSourceObservation) => void) | undefined
  const backend = {
    id: "system",
    label: "fixture",
    remoteControl: true,
    authenticated: () => true,
    player: async () => null,
    play: async () => {},
    subscribeSourceObservations: (
      sink: (o: ProviderSourceObservation) => void,
    ) => {
      listener = sink
      sink({ sequence: 1, kind: "snapshot", hint: { processIdentifier: 42 } })
      return () => {
        listener = undefined
      }
    },
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* SessionProvider
        const observed = yield* Latch.make(false)
        const later = yield* Latch.make(false)
        const releases = yield* Ref.make(0)
        const capture = yield* makeAudioCapture({
          daemonInstanceId: "fixture",
          nowMs: () => 0,
          observations: provider.sourceObservations.pipe(
            Stream.tap((o) =>
              o.sequence === 1
                ? Latch.open(observed)
                : o.sequence === 3
                  ? Latch.open(later)
                  : Effect.void,
            ),
          ),
          resolver: {
            ...resolver,
            list: () =>
              Effect.succeed({
                availability: "available",
                sources: [{ ...source, mode: "now-playing" }],
              }),
          },
          adapter: {
            availability: "available",
            start: () =>
              Effect.addFinalizer(() =>
                Ref.update(releases, (n) => n + 1),
              ).pipe(Effect.as({ frames: Stream.never })),
          },
        })
        yield* Latch.await(observed)
        yield* capture.start("a", yield* select(capture, "a"))
        yield* Effect.sync(() => {
          if (!listener) throw new Error("missing source subscription")
          listener({ sequence: 2, kind: "invalidation", hint: undefined })
          listener({
            sequence: 3,
            kind: "snapshot",
            hint: { processIdentifier: 42 },
          })
        })
        yield* Latch.await(later)
        expect(yield* capture.status()).toMatchObject({
          type: "stopped",
          reason: "source-loss",
        })
        expect(yield* Ref.get(releases)).toBe(1)
      }).pipe(Effect.provide(layerFromAttemptAdapter(backend))),
    ),
  )
})

test("adapter acquisition defects report setup after cleanup and allow a fresh generation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const releases = yield* Ref.make(0)
        const starts = yield* Ref.make(0)
        const capture = yield* makeAudioCapture({
          daemonInstanceId: "fixture",
          nowMs: () => 0,
          observations: Stream.never,
          resolver,
          adapter: {
            availability: "available",
            start: () =>
              Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(starts, (n) => n + 1)
                yield* Effect.addFinalizer(() =>
                  Ref.update(releases, (n) => n + 1),
                )
                if (count === 1)
                  return yield* Effect.die(
                    new Error("fixture acquisition defect"),
                  )
                return { frames: Stream.never }
              }),
          },
        })
        expect(yield* capture.start("a", yield* select(capture, "a"))).toEqual({
          type: "failed",
          reason: "setup",
        })
        expect(yield* Ref.get(releases)).toBe(1)
        expect(yield* capture.status()).toMatchObject({
          type: "failed",
          reason: "setup",
        })
        expect(
          yield* capture.start("b", yield* select(capture, "b")),
        ).toMatchObject({ type: "started", generation: 2 })
      }),
    ),
  )
})

test("interruption before admission cancels validation without acquiring a helper", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const validating = yield* Latch.make(false)
        const starts = yield* Ref.make(0)
        const capture = yield* makeAudioCapture({
          daemonInstanceId: "fixture",
          nowMs: () => 0,
          observations: Stream.never,
          resolver: {
            ...resolver,
            revalidate: () =>
              Latch.open(validating).pipe(Effect.andThen(Effect.never)),
          },
          adapter: {
            availability: "available",
            start: () =>
              Ref.update(starts, (n) => n + 1).pipe(
                Effect.as({ frames: Stream.never }),
              ),
          },
        })
        const starting = yield* capture
          .start("a", yield* select(capture, "a"))
          .pipe(Effect.forkChild)
        yield* Latch.await(validating)
        yield* Fiber.interrupt(starting)
        expect(yield* Ref.get(starts)).toBe(0)
        expect(yield* capture.status()).toEqual({ type: "idle" })
      }),
    ),
  )
})

test("a synchronous adapter acquisition defect releases its slot for a later explicit Start", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let starts = 0
        const capture = yield* makeAudioCapture({
          daemonInstanceId: "fixture",
          nowMs: () => 0,
          observations: Stream.never,
          resolver,
          adapter: {
            availability: "available",
            start: () => {
              if (++starts === 1)
                throw new Error("fixture synchronous acquisition defect")
              return Effect.succeed({ frames: Stream.never })
            },
          },
        })
        expect(yield* capture.start("a", yield* select(capture, "a"))).toEqual({
          type: "failed",
          reason: "setup",
        })
        expect(yield* capture.status()).toMatchObject({
          type: "failed",
          reason: "setup",
        })
        expect(
          yield* capture.start("b", yield* select(capture, "b")),
        ).toMatchObject({ type: "started", generation: 2 })
        expect(starts).toBe(2)
      }),
    ),
  )
})

test("interrupted acquisition remains pending until its exact cleanup completes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        yield* Effect.gen(function* () {
          const starting = yield* f.capture
            .start("a", yield* select(f.capture, "a"))
            .pipe(Effect.forkChild)
          yield* Latch.await(f.entered)
          yield* Latch.close(f.release)
          const interrupting = yield* Fiber.interrupt(starting).pipe(
            Effect.forkChild,
          )
          yield* Latch.await(f.closing)
          expect(interrupting.pollUnsafe()).toBeUndefined()
          expect(starting.pollUnsafe()).toBeUndefined()
          expect(yield* Ref.get(f.releases)).toBe(0)
          yield* Latch.open(f.release)
          yield* Fiber.join(interrupting)
          expect(yield* Ref.get(f.releases)).toBe(1)
        }).pipe(Effect.ensuring(Latch.open(f.release)))
      }),
    ),
  )
})

test("interrupting one same-connection admission preserves its other pending admission", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const first = yield* f.capture
          .start("a", yield* select(f.capture, "a"))
          .pipe(Effect.forkChild)
        yield* Latch.await(f.entered)
        yield* Latch.close(f.admitted)
        const second = yield* f.capture
          .start("a", yield* select(f.capture, "a"))
          .pipe(Effect.forkChild)
        yield* Latch.await(f.admitted)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(second)
        expect(yield* Ref.get(f.releases)).toBe(0)
        yield* Latch.open(f.ready)
        expect((yield* Fiber.join(first)).type).toBe("started")
        yield* f.capture.detach("a")
        expect(yield* Ref.get(f.releases)).toBe(1)
      }),
    ),
  )
})

test("provider source overflow fails closed and joins native cleanup", async () => {
  let listener: ((o: ProviderSourceObservation) => void) | undefined
  const backend = {
    id: "system",
    label: "fixture",
    remoteControl: true,
    authenticated: () => true,
    player: async () => null,
    play: async () => {},
    subscribeSourceObservations: (
      sink: (o: ProviderSourceObservation) => void,
    ) => {
      listener = sink
      sink({ sequence: 1, kind: "snapshot", hint: { processIdentifier: 42 } })
      return () => {
        listener = undefined
      }
    },
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* SessionProvider
        const observed = yield* Latch.make(false)
        const confirming = yield* Latch.make(false)
        const confirm = yield* Latch.make(false)
        const releases = yield* Ref.make(0)
        const capture = yield* makeAudioCapture({
          daemonInstanceId: "fixture",
          nowMs: () => 0,
          observations: provider.sourceObservations.pipe(
            Stream.tap(() => Latch.open(observed)),
          ),
          resolver: {
            ...resolver,
            list: () =>
              Effect.succeed({
                availability: "available",
                sources: [{ ...source, mode: "now-playing" }],
              }),
            confirm: () =>
              Latch.open(confirming).pipe(
                Effect.andThen(Latch.await(confirm)),
                Effect.as("same"),
              ),
          },
          adapter: {
            availability: "available",
            start: () =>
              Effect.addFinalizer(() =>
                Ref.update(releases, (n) => n + 1),
              ).pipe(Effect.as({ frames: Stream.never })),
          },
        })
        yield* Latch.await(observed)
        yield* capture.start("a", yield* select(capture, "a"))
        const stopped = yield* capture.subscribeStatus("a").pipe(
          Stream.filter((s) => s.type === "stopped"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        )
        yield* Effect.sync(() => {
          if (!listener) throw new Error("missing source subscription")
          listener({
            sequence: 2,
            kind: "snapshot",
            hint: { processIdentifier: 42 },
          })
        })
        yield* Latch.await(confirming)
        yield* Effect.sync(() => {
          if (!listener) throw new Error("missing source subscription")
          for (let sequence = 3; sequence <= 100; sequence++)
            listener({
              sequence,
              kind: "snapshot",
              hint: { processIdentifier: 42 },
            })
        })
        expect(stopped.pollUnsafe()).toBeUndefined()
        yield* Latch.open(confirm)
        expect((yield* Fiber.join(stopped))[0]).toMatchObject({
          type: "stopped",
          reason: "source-loss",
        })
        expect(yield* Ref.get(releases)).toBe(1)
        expect(yield* capture.renew("a", 1)).toEqual({
          type: "rejected",
          reason: "not-joined",
        })
        // A dead observation subscription cannot supervise a new generation.
        expect(yield* capture.start("b", yield* select(capture, "b"))).toEqual({
          type: "rejected",
          reason: "unresolved-source",
        })
      }).pipe(Effect.provide(layerFromAttemptAdapter(backend))),
    ),
  )
})

test("failed cleanup supersedes the active stream failure and fences later Starts", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* Scope.make()
        const finish = yield* Latch.make(false)
        const releases = yield* Ref.make(0)
        const capture = yield* Scope.provide(owner)(
          makeAudioCapture({
            daemonInstanceId: "fixture",
            nowMs: () => 0,
            observations: Stream.never,
            resolver,
            adapter: {
              availability: "available",
              start: () =>
                Effect.addFinalizer(() =>
                  Ref.update(releases, (n) => n + 1).pipe(
                    Effect.andThen(
                      Effect.die(new Error("fixture cleanup defect")),
                    ),
                  ),
                ).pipe(
                  Effect.as({
                    frames: Stream.fromEffect(Latch.await(finish)).pipe(
                      Stream.drain,
                      Stream.concat(
                        Stream.fail(
                          new AudioAdapterError({ reason: "permission" }),
                        ),
                      ),
                    ),
                  }),
                ),
            },
          }),
        )
        yield* capture.start("a", yield* select(capture, "a"))
        const failed = yield* capture.subscribeStatus("a").pipe(
          Stream.filter((s) => s.type === "failed"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        )
        yield* Latch.open(finish)
        expect((yield* Fiber.join(failed))[0]).toEqual({
          type: "failed",
          generation: 1,
          reason: "setup",
        })
        expect(yield* Ref.get(releases)).toBe(1)
        const next = yield* capture
          .start("b", yield* select(capture, "b"))
          .pipe(Effect.exit)
        expect(next._tag).toBe("Failure")
        // Owner close also reports the shared cleanup failure; it cannot claim release.
        expect(
          Exit.isFailure(
            yield* Scope.close(owner, Exit.void).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    ),
  )
})

for (const reason of ["timeout", "setup", "permission"] as const) {
  test(`active ${reason} failure remains truthful after blocked cleanup`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const finish = yield* Latch.make(false)
          const closing = yield* Latch.make(false)
          const release = yield* Latch.make(false)
          const capture = yield* makeAudioCapture({
            daemonInstanceId: "fixture",
            nowMs: () => 0,
            observations: Stream.never,
            resolver,
            adapter: {
              availability: "available",
              start: () =>
                Effect.addFinalizer(() =>
                  Latch.open(closing).pipe(
                    Effect.andThen(Latch.await(release)),
                  ),
                ).pipe(
                  Effect.as({
                    frames: Stream.fromEffect(Latch.await(finish)).pipe(
                      Stream.drain,
                      Stream.concat(
                        Stream.fail(new AudioAdapterError({ reason })),
                      ),
                    ),
                  }),
                ),
            },
          })
          yield* Effect.gen(function* () {
            yield* capture.start("a", yield* select(capture, "a"))
            const terminal = yield* capture.subscribeStatus("a").pipe(
              Stream.filter((s) => s.type === "stopped" || s.type === "failed"),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkChild,
            )
            yield* Latch.open(finish)
            yield* Latch.await(closing)
            expect(terminal.pollUnsafe()).toBeUndefined()
            yield* Latch.open(release)
            expect((yield* Fiber.join(terminal))[0]).toEqual({
              type: "failed",
              generation: 1,
              reason,
            })
          }).pipe(Effect.ensuring(Latch.open(release)))
        }),
      ),
    )
  })
}

test("Stop joins a canceled revalidation after native cleanup fails", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const owner = yield* Scope.make()
      yield* Effect.gen(function* () {
        const secondEntered = yield* Latch.make(false)
        const secondCleanupEntered = yield* Latch.make(false)
        const releaseSecondCleanup = yield* Latch.make(false)
        const nativeCleanupEntered = yield* Latch.make(false)
        const releaseNative = yield* Latch.make(false)
        const peerEntered = yield* Latch.make(false)
        const releasePeer = yield* Latch.make(false)
        let validations = 0
        const capture = yield* makeAudioCapture({
          daemonInstanceId: "fixture",
          nowMs: () => 0,
          observations: Stream.never,
          resolver: {
            ...resolver,
            revalidate: (selected) =>
              Effect.gen(function* () {
                validations += 1
                if (validations === 1) return selected
                if (validations === 2) {
                  // Cancellation must finish this cleanup before Stop can return.
                  return yield* Latch.open(secondEntered).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(
                      Latch.open(secondCleanupEntered).pipe(
                        Effect.andThen(Latch.await(releaseSecondCleanup)),
                      ),
                    ),
                  )
                }
                yield* Latch.open(peerEntered)
                return yield* Latch.await(releasePeer).pipe(Effect.as(selected))
              }),
          },
          adapter: {
            availability: "available",
            start: () =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Latch.open(nativeCleanupEntered).pipe(
                    Effect.andThen(Latch.await(releaseNative)),
                    Effect.andThen(
                      Effect.die(new Error("native cleanup failed")),
                    ),
                  ),
                )
                return { frames: Stream.never }
              }),
          },
        })
        yield* Effect.gen(function* () {
          expect(
            (yield* capture.start("a", yield* select(capture, "a"))).type,
          ).toBe("started")
          const second = yield* capture
            .start("a", yield* select(capture, "a"))
            .pipe(Effect.forkChild)
          yield* Latch.await(secondEntered)
          const peer = yield* capture
            .start("b", yield* select(capture, "b"))
            .pipe(Effect.forkChild)
          yield* Latch.await(peerEntered)
          const stopping = yield* capture.stop("a").pipe(Effect.forkChild)
          yield* Latch.await(secondCleanupEntered)
          yield* Latch.await(nativeCleanupEntered)
          yield* Latch.open(releaseNative)
          for (let turn = 0; turn < 8; turn++) yield* Effect.yieldNow
          // Native cleanup has already failed. Stop must still be joining the
          // canceled Start, not returning while that cleanup is pending.
          expect(stopping.pollUnsafe()).toBeUndefined()
          expect(peer.pollUnsafe()).toBeUndefined()
          yield* Latch.open(releaseSecondCleanup)
          const stopped = yield* Fiber.join(stopping).pipe(Effect.exit)
          expect(Exit.isFailure(stopped)).toBe(true)
          if (Exit.isFailure(stopped))
            expect(Cause.pretty(stopped.cause)).toContain(
              "native cleanup failed",
            )
          expect(yield* Fiber.join(second)).toEqual({
            type: "rejected",
            reason: "canceled",
          })
          // A's failed Stop fences only A's attempt. The peer stays blocked.
          expect(peer.pollUnsafe()).toBeUndefined()
        }).pipe(
          Effect.ensuring(Latch.open(releaseNative)),
          Effect.ensuring(Latch.open(releaseSecondCleanup)),
          Effect.ensuring(Latch.open(releasePeer)),
        )
      }).pipe(Scope.provide(owner))
      // Owner close also reports the shared cleanup defect; it cannot claim release.
      const ownerClosed = yield* Scope.close(owner, Exit.void).pipe(Effect.exit)
      expect(Exit.isFailure(ownerClosed)).toBe(true)
    }),
  )
})
