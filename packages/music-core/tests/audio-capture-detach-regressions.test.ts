import { expect, test } from "bun:test"
import {
  Effect,
  Exit,
  Fiber,
  Latch,
  Ref,
  Scheduler,
  Scope,
  Stream,
} from "effect"
import {
  makeAudioCapture,
  unavailableLayer,
  AudioCapture,
} from "../audio/capture.ts"
import type { ResolvedCaptureSource } from "../audio/schema.ts"
import type { ProviderSourceObservation } from "../audio/source.ts"
import {
  layerFromAttemptAdapter,
  SessionProvider,
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

for (const priorOwner of ["none", "same-connection", "peer"] as const) {
  test(`interrupt at the final masked admission rolls back only its own interest (${priorOwner})`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let starting: Fiber.Fiber<unknown, unknown> | undefined
          let reads = 0
          let interruptAt = Infinity
          let interrupted = false
          const releases = yield* Ref.make(0)
          const capture = yield* makeAudioCapture({
            daemonInstanceId: "fixture",
            observations: Stream.never,
            resolver,
            nowMs: () => {
              if (++reads === interruptAt) {
                if (!starting)
                  throw new Error("caller fiber must exist before the commit")
                interrupted = true
                starting.interruptUnsafe()
              }
              return 0
            },
            adapter: {
              availability: "available",
              start: () =>
                Effect.addFinalizer(() =>
                  Ref.update(releases, (n) => n + 1),
                ).pipe(Effect.as({ frames: Stream.never })),
            },
          })
          if (priorOwner !== "none") {
            const id = priorOwner === "peer" ? "b" : "a"
            yield* capture.start(id, yield* select(capture, id))
          }
          const token = yield* select(capture, "a")
          reads = 0
          // These are the pinned implementation's lease reads, including the final
          // joined check inside the mask. No timer or scheduler race chooses the cut.
          interruptAt = priorOwner === "none" ? 3 : 4
          starting = yield* capture.start("a", token).pipe(Effect.forkChild)
          const exit = yield* Fiber.await(starting)
          expect(interrupted).toBe(true)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(yield* capture.renew("a", 1)).toEqual(
            priorOwner === "same-connection"
              ? { type: "renewed", generation: 1 }
              : { type: "rejected", reason: "not-joined" },
          )
          if (priorOwner === "peer")
            expect(yield* capture.renew("b", 1)).toEqual({
              type: "renewed",
              generation: 1,
            })
          expect(yield* Ref.get(releases)).toBe(priorOwner === "none" ? 1 : 0)
        }),
      ),
    )
  })
}

const fixture = (failCleanup = false) =>
  Effect.gen(function* () {
    const closing = yield* Latch.make(false)
    const release = yield* Latch.make(false)
    const releases = yield* Ref.make(0)
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
              Effect.andThen(Ref.update(releases, (n) => n + 1)),
              Effect.andThen(
                failCleanup
                  ? Effect.die(new Error("fixture cleanup defect"))
                  : Effect.void,
              ),
            ),
          ).pipe(Effect.as({ frames: Stream.never })),
      },
    })
    return { capture, closing, release, releases }
  })

test("beginDetach revokes authority before returning and owns cleanup before completion is joined", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* Effect.gen(function* () {
          yield* f.capture.start("a", yield* select(f.capture, "a"))
          const completion = yield* f.capture.beginDetach("a")
          expect(yield* f.capture.renew("a", 1)).toEqual({
            type: "rejected",
            reason: "not-joined",
          })
          yield* Latch.await(f.closing)
          expect(yield* Ref.get(f.releases)).toBe(0)
          const joined = yield* completion.pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(joined.pollUnsafe()).toBeUndefined()
          yield* Latch.open(f.release)
          yield* Fiber.join(joined)
          yield* completion
          expect(yield* Ref.get(f.releases)).toBe(1)
        }).pipe(Effect.ensuring(Latch.open(f.release)))
      }),
    ),
  )
})

test("detach completion and a non-detaching old feature stream cannot delete tokens issued after logical detach", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* Effect.gen(function* () {
          const oldFeatures = yield* f.capture
            .subscribeFeatures("a", { detachOnClose: false })
            .pipe(Stream.runDrain, Effect.forkChild)
          yield* Effect.yieldNow
          yield* f.capture.start("a", yield* select(f.capture, "a"))
          const oldToken = yield* select(f.capture, "a")
          const completion = yield* f.capture.beginDetach("a")
          yield* Latch.await(f.closing)
          const newToken = yield* select(f.capture, "a")
          yield* Fiber.interrupt(oldFeatures)
          yield* Latch.open(f.release)
          yield* completion
          expect(yield* f.capture.start("a", oldToken)).toEqual({
            type: "rejected",
            reason: "unknown-token",
          })
          expect(yield* f.capture.start("a", newToken)).toMatchObject({
            type: "started",
            generation: 2,
          })
        }).pipe(Effect.ensuring(Latch.open(f.release)))
      }),
    ),
  )
})

test("beginDetach preserves a healthy peer and repeated calls join one blocked retirement", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* Effect.gen(function* () {
          yield* f.capture.start("a", yield* select(f.capture, "a"))
          yield* f.capture.start("b", yield* select(f.capture, "b"))
          yield* yield* f.capture.beginDetach("a")
          expect(yield* f.capture.renew("b", 1)).toEqual({
            type: "renewed",
            generation: 1,
          })
          expect(yield* Ref.get(f.releases)).toBe(0)
          const first = yield* f.capture.beginDetach("b")
          yield* Latch.await(f.closing)
          const second = yield* f.capture.beginDetach("b")
          const one = yield* first.pipe(Effect.forkChild)
          const two = yield* second.pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(one.pollUnsafe()).toBeUndefined()
          expect(two.pollUnsafe()).toBeUndefined()
          yield* Latch.open(f.release)
          yield* Fiber.join(one)
          yield* Fiber.join(two)
          expect(yield* Ref.get(f.releases)).toBe(1)
        }).pipe(Effect.ensuring(Latch.open(f.release)))
      }),
    ),
  )
})

test("beginDetach completions preserve the shared cleanup defect", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* Scope.make()
        const f = yield* Scope.provide(owner)(fixture(true))
        yield* f.capture.start("a", yield* select(f.capture, "a"))
        const first = yield* f.capture.beginDetach("a")
        yield* Latch.await(f.closing)
        const second = yield* f.capture.beginDetach("a")
        yield* Latch.open(f.release)
        expect(Exit.isFailure(yield* first.pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* second.pipe(Effect.exit))).toBe(true)
        expect(yield* f.capture.status()).toEqual({
          type: "failed",
          generation: 1,
          reason: "setup",
        })
        expect(yield* Ref.get(f.releases)).toBe(1)
        expect(
          Exit.isFailure(
            yield* Scope.close(owner, Exit.void).pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    ),
  )
})

test("unavailable capture also implements the split-phase detach contract", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* AudioCapture
        yield* yield* capture.beginDetach("a")
        expect((yield* capture.status()).type).toBe("unavailable")
      }).pipe(Effect.provide(unavailableLayer("fixture"))),
    ),
  )
})

test("an old successful handoff cannot borrow a replacement attempt on the same connection and generation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cut = yield* Latch.make(false)
        const base = new Scheduler.MixedScheduler()
        let pauseNextTask = false
        let resume: (() => void) | undefined
        let reads = 0
        let armed = false
        const scheduler: Scheduler.Scheduler = {
          executionMode: base.executionMode,
          shouldYield: (fiber) => {
            if (armed && reads >= 3) {
              armed = false
              pauseNextTask = true
              return true
            }
            return base.shouldYield(fiber)
          },
          makeDispatcher: () => {
            const dispatcher = base.makeDispatcher()
            return {
              flush: () => dispatcher.flush(),
              scheduleTask: (task, priority) => {
                if (pauseNextTask) {
                  pauseNextTask = false
                  resume = () => dispatcher.scheduleTask(task, priority)
                  Latch.openUnsafe(cut)
                } else dispatcher.scheduleTask(task, priority)
              },
            }
          },
        }
        const releases = yield* Ref.make(0)
        const capture = yield* makeAudioCapture({
          daemonInstanceId: "fixture",
          observations: Stream.never,
          resolver,
          nowMs: () => {
            reads++
            return 0
          },
          adapter: {
            availability: "available",
            start: () =>
              Effect.addFinalizer(() =>
                Ref.update(releases, (n) => n + 1),
              ).pipe(Effect.as({ frames: Stream.never })),
          },
        })
        yield* capture.start("b", yield* select(capture, "b"))
        const oldToken = yield* select(capture, "a")
        reads = 0
        armed = true
        // Pause after the atomic claim, before returning its already-successful
        // joined result. A peer keeps this exact generation alive across detach.
        const old = yield* capture
          .start("a", oldToken)
          .pipe(
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          )
        yield* Latch.await(cut)
        yield* Effect.gen(function* () {
          const completion = yield* capture.beginDetach("a")
          expect(
            yield* capture.start("a", yield* select(capture, "a")),
          ).toMatchObject({ type: "joined", generation: 1 })
          yield* Effect.sync(() => resume?.())
          expect(yield* Fiber.join(old)).toEqual({
            type: "rejected",
            reason: "canceled",
          })
          yield* completion
          expect(yield* capture.renew("a", 1)).toEqual({
            type: "renewed",
            generation: 1,
          })
          expect(yield* capture.renew("b", 1)).toEqual({
            type: "renewed",
            generation: 1,
          })
          expect(yield* Ref.get(releases)).toBe(0)
        }).pipe(Effect.ensuring(Effect.sync(() => resume?.())))
      }),
    ),
  )
})

for (const registered of [false, true]) {
  test(`logical detach fences an old Start ${registered ? "during validation" : "before capture registration"} without an extra server epoch`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Latch.make(false)
          const resume = yield* Latch.make(false)
          let starts = 0
          const capture = yield* makeAudioCapture({
            daemonInstanceId: "fixture",
            nowMs: () => 0,
            observations: Stream.never,
            resolver: {
              ...resolver,
              revalidate: (selected) =>
                registered
                  ? Latch.open(entered).pipe(
                      Effect.andThen(Latch.await(resume)),
                      Effect.as(selected),
                    )
                  : Effect.succeed(selected),
            },
            adapter: {
              availability: "available",
              start: () =>
                Effect.sync(() => {
                  starts++
                  return { frames: Stream.never }
                }),
            },
          })
          const token = yield* select(capture, "a")
          const old = yield* (
            registered
              ? capture.start("a", token)
              : Latch.open(entered).pipe(
                  Effect.andThen(Latch.await(resume)),
                  Effect.andThen(capture.start("a", token)),
                )
          ).pipe(Effect.forkChild)
          yield* Latch.await(entered)
          const completion = yield* capture.beginDetach("a")
          const newToken = yield* select(capture, "a")
          yield* Latch.open(resume)
          expect(yield* Fiber.join(old)).toEqual({
            type: "rejected",
            reason: registered ? "canceled" : "unknown-token",
          })
          yield* completion
          expect(starts).toBe(0)
          expect(yield* capture.start("a", newToken)).toMatchObject({
            type: "started",
            generation: 1,
          })
          expect(starts).toBe(1)
        }),
      ),
    )
  })
}

test("provider overflow revokes renewable authority and enters cleanup before blocked confirmation is released", async () => {
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
        const interrupted = yield* Latch.make(false)
        const closing = yield* Latch.make(false)
        const release = yield* Latch.make(false)
        yield* Effect.gen(function* () {
          const capture = yield* makeAudioCapture({
            daemonInstanceId: "fixture",
            nowMs: () => 0,
            observations: provider.sourceObservations.pipe(
              Stream.tap(() => Latch.open(observed)),
            ),
            resolver: {
              ...resolver,
              confirm: () =>
                Latch.open(confirming).pipe(
                  Effect.andThen(Latch.await(confirm)),
                  Effect.as("same" as const),
                  Effect.onInterrupt(() => Latch.open(interrupted)),
                ),
            },
            adapter: {
              availability: "available",
              start: () =>
                Effect.addFinalizer(() =>
                  Latch.open(closing).pipe(
                    Effect.andThen(Latch.await(release)),
                  ),
                ).pipe(Effect.as({ frames: Stream.never })),
            },
          })
          yield* Latch.await(observed)
          yield* capture.start("a", yield* select(capture, "a"))
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
          yield* Effect.yieldNow
          expect(yield* capture.renew("a", 1)).toEqual({
            type: "rejected",
            reason: "not-joined",
          })
          yield* Latch.await(closing)
          yield* Latch.await(interrupted)
          yield* Latch.open(release)
          yield* capture.detach("a")
          expect(yield* capture.status()).toMatchObject({
            type: "stopped",
            reason: "source-loss",
          })
        }).pipe(
          Effect.ensuring(
            Latch.open(confirm).pipe(Effect.andThen(Latch.open(release))),
          ),
        )
      }).pipe(Effect.provide(layerFromAttemptAdapter(backend))),
    ),
  )
})
