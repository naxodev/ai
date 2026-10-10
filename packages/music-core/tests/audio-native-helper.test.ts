import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { lstatSync } from "node:fs"
import { join } from "node:path"
import { testUnixSession } from "./unix-session.ts"
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Latch,
  Queue,
  Result,
  Scope,
  Schema,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { AudioAdapterError, makeAudioCapture } from "../audio/capture.ts"
import {
  makeHelperTermination,
  makeHelperVerifier,
  liveNativeHelperDependencies,
} from "../audio/helper-process.ts"
import { localMonotonicMs } from "../audio/clock.ts"
import {
  makeNativeHelperAdapter,
  type NativeHelperDependencies,
  type NativeHelperExit,
  type NativeHelperProcess,
  type NativeHelperSpawnRequest,
} from "../audio/native-helper.ts"
import {
  MAX_AUDIO_FEATURE_FRAME_BYTES,
  type ResolvedCaptureSource,
} from "../audio/schema.ts"

const source: ResolvedCaptureSource = {
  mode: "process",
  label: "Offline player",
  observationSequence: 1,
  capabilities: {
    spectrum: "measured",
    envelope: "absent",
    channels: "absent",
  },
  identity: {
    kind: "native",
    processIdentifier: 42,
    launchIdentity: "launch-fixture",
    executableIdentity: "executable-fixture",
    coreAudioObject: "object-fixture",
  },
}
const draft = (n = 1) => ({
  timestampMs: n,
  sampleAgeMs: 0,
  clockDomain: "capture-monotonic",
  spectrum: [n],
})
const line = (n = 1) => Buffer.from(`${JSON.stringify(draft(n))}\n`)
const assertFailure = <A>(
  exit: Exit.Exit<A, AudioAdapterError>,
  reason: AudioAdapterError["reason"],
) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("expected a typed adapter failure")
  expect(Cause.hasDies(exit.cause)).toBe(false)
  const failure = Cause.findError(exit.cause)
  expect(Result.isSuccess(failure)).toBe(true)
  if (Result.isFailure(failure)) throw new Error("missing adapter error")
  expect(failure.success).toBeInstanceOf(AudioAdapterError)
  expect(failure.success.reason).toBe(reason)
}

const fakeHelper = (autoExit = true) =>
  Effect.gen(function* () {
    const input = yield* Queue.bounded<Uint8Array | Latch.Latch, Cause.Done>(1)
    const exited = yield* Deferred.make<NativeHelperExit>()
    const spawned = yield* Latch.make(false)
    const stopping = yield* Latch.make(false)
    const signaled = yield* Latch.make(false)
    const reading = yield* Latch.make(false)
    const events: string[] = []
    const requests: NativeHelperSpawnRequest[] = []
    let heartbeats = 0
    let exitWaits = 0
    const process: NativeHelperProcess = {
      ready: Effect.void,
      stdout: Stream.fromEffect(Latch.open(reading)).pipe(
        Stream.drain,
        Stream.concat(Stream.fromQueue(input)),
        Stream.flatMap((item) =>
          item instanceof Uint8Array
            ? Stream.make(item)
            : Stream.fromEffect(Latch.open(item)).pipe(Stream.drain),
        ),
        Stream.onExit(() =>
          Effect.sync(() => {
            events.push("stdout-ended")
          }),
        ),
      ),
      stderr: Stream.never,
      exit: Deferred.await(exited).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            exitWaits++
          }),
        ),
      ),
      heartbeat: Effect.sync(() => {
        heartbeats++
      }),
      stopIO: () => {
        events.push("stop-io")
        stopping.openUnsafe()
      },
      signal: (signal) => {
        events.push(signal)
        if (autoExit)
          Deferred.doneUnsafe(
            exited,
            Effect.succeed(
              signal === "SIGTERM"
                ? { code: 0, signal: null }
                : { code: null, signal },
            ),
          )
        signaled.openUnsafe()
      },
    }
    const dependencies: NativeHelperDependencies = {
      artifactPresent: () => true,
      verify: () => Effect.succeed(true),
      spawn: (request) => {
        requests.push(request)
        spawned.openUnsafe()
        return process
      },
    }
    const flush = Effect.gen(function* () {
      const consumed = yield* Latch.make(false)
      yield* Queue.offer(input, consumed)
      yield* Latch.await(consumed)
    })
    return {
      process,
      dependencies,
      input,
      exited,
      spawned,
      stopping,
      signaled,
      reading,
      events,
      requests,
      flush,
      heartbeats: () => heartbeats,
      exitWaits: () => exitWaits,
    }
  })

describe("offline native helper process boundary", () => {
  testUnixSession(
    "real pipe readers retain later bursts, carry the parent's clock, and join explicit closure",
    async () => {
      const Ack = Schema.Struct({
        seq: Schema.Number,
        clockDomain: Schema.optionalKey(Schema.String),
        timestampMs: Schema.optionalKey(Schema.Finite),
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { process, terminate } = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const process = liveNativeHelperDependencies.spawn({
                  executable: globalThis.process.execPath,
                  shell: false,
                  args: [
                    "-e",
                    `let buffer = "", seq = 0
process.stdin.on("data", chunk => {
  buffer += chunk.toString()
  let split
  while ((split = buffer.indexOf("\\n")) >= 0) {
    const value = JSON.parse(buffer.slice(0, split))
    buffer = buffer.slice(split + 1)
    console.log(JSON.stringify({ seq: ++seq, clockDomain: value.clockDomain, timestampMs: value.timestampMs }))
  }
})
process.stdin.on("end", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))`,
                  ],
                })
                const terminate = yield* makeHelperTermination(process)
                yield* Effect.addFinalizer(() => terminate.pipe(Effect.orDie))
                return { process, terminate }
              }),
            )
            yield* process.ready
            const received =
              yield* Queue.bounded<Schema.Schema.Type<typeof Ack>>(1)
            let buffer = ""
            const decoder = new TextDecoder()
            const reader = yield* process.stdout.pipe(
              Stream.runForEach((chunk) =>
                Effect.gen(function* () {
                  buffer += decoder.decode(chunk, { stream: true })
                  let split: number
                  while ((split = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, split)
                    buffer = buffer.slice(split + 1)
                    const ack = Schema.decodeUnknownSync(Ack)(JSON.parse(line))
                    yield* Queue.offer(received, ack)
                  }
                }),
              ),
              Effect.forkScoped,
            )
            const before = localMonotonicMs()
            yield* process.heartbeat
            const first = yield* Queue.take(received)
            expect(first.seq).toBe(1)
            yield* process.heartbeat
            const second = yield* Queue.take(received)
            expect(second.seq).toBe(2)
            expect(second.clockDomain).toBe("capture-monotonic")
            if (second.timestampMs === undefined)
              throw new Error("heartbeat did not include the parent clock")
            expect(second.timestampMs).toBeGreaterThanOrEqual(before)
            expect(second.timestampMs).toBeLessThanOrEqual(localMonotonicMs())
            yield* terminate
            yield* Fiber.join(reader)
          }),
        ).pipe(Effect.timeout("2 seconds")),
      )
    },
  )

  // System signing verification needs macOS, but never starts audio capture.
  test.skipIf(process.platform !== "darwin")(
    "a valid signed executable passes the real verifier only with the required identity",
    async () => {
      const verify = makeHelperVerifier({
        regularFile: (path) => lstatSync(path).isFile(),
        codesign: (args) =>
          Effect.sync(
            () =>
              Bun.spawnSync(["/usr/bin/codesign", ...args], {
                timeout: 5_000,
                stdout: "pipe",
                stderr: "pipe",
              }).success,
          ),
      })
      expect(
        await Effect.runPromise(verify("/bin/echo", "com.apple.echo")),
      ).toBe(true)
      expect(
        await Effect.runPromise(
          verify("/bin/echo", "dev.naxo.music.audio-helper"),
        ),
      ).toBe(false)
    },
  )

  for (const outcome of [
    { code: 70, signal: null },
    { code: 125, signal: null },
    { code: null, signal: "SIGTERM" },
    { code: null, signal: "SIGKILL" },
    { code: null, signal: "SIGABRT" },
  ]) {
    test(`native exit ${outcome.signal ?? outcome.code} cannot claim completed resource cleanup`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const helper = yield* fakeHelper(false)
            yield* Deferred.succeed(helper.exited, outcome)
            const terminate = yield* makeHelperTermination(helper.process)
            assertFailure(yield* terminate.pipe(Effect.exit), "setup")
            expect(helper.events).not.toContain("SIGKILL")
            expect(helper.exitWaits()).toBe(1)
          }),
        ),
      )
    })
  }

  for (const state of ["missing", "unsigned", "tampered", "wrong-identifier"]) {
    test(`${state} helper is unavailable and cannot reach spawn`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            let spawns = 0
            const files: string[] = []
            const commands: ReadonlyArray<string>[] = []
            const dependencies: NativeHelperDependencies = {
              artifactPresent: () => state !== "missing",
              verify: makeHelperVerifier({
                regularFile: (path) => {
                  files.push(path)
                  if (state === "missing")
                    throw new Error("offline missing helper")
                  return true
                },
                codesign: (args) => {
                  commands.push(args)
                  // The command boundary reports a strict-integrity or identity
                  // rejection, not a successful verification of another binary.
                  return Effect.succeed(false)
                },
              }),
              spawn: () => {
                spawns++
                throw new Error("unverified helper must not spawn")
              },
            }
            const adapter = yield* makeNativeHelperAdapter(dependencies)
            // Availability follows the artifact, so one rejected check cannot
            // make a corrected helper unreachable for the daemon's lifetime.
            const expected = state === "missing" ? "unavailable" : "available"
            expect(adapter.availability).toBe(expected)
            assertFailure(
              yield* adapter.start(source).pipe(Effect.exit),
              "unavailable",
            )
            expect(spawns).toBe(0)
            expect(files).toHaveLength(1)
            const path = files[0]
            if (path === undefined)
              throw new Error("verification did not resolve a helper")
            expect(path).toEndWith(
              join("audio", "native", "music-audio-helper"),
            )
            expect(commands).toHaveLength(state === "missing" ? 0 : 1)
            expect(adapter.availability).toBe(expected)
            for (const args of commands)
              expect(args).toEqual([
                "--verify",
                "--strict",
                "-R",
                '=identifier "dev.naxo.music.audio-helper"',
                path,
              ])
          }),
        ),
      )
    })
  }

  test("Start verifies integrity itself and refuses an unverified helper without spawning", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const helper = yield* fakeHelper()
          let checks = 0
          const adapter = yield* makeNativeHelperAdapter({
            ...helper.dependencies,
            verify: () =>
              Effect.sync(() => {
                checks += 1
                return false
              }),
          })
          expect(adapter.availability).toBe("available")
          assertFailure(
            yield* adapter.start(source).pipe(Effect.exit),
            "unavailable",
          )
          expect(checks).toBe(1)
          expect(helper.requests).toHaveLength(0)
        }),
      ),
    )
  })

  test("a helper installed after daemon start stays listable and becomes usable", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const helper = yield* fakeHelper()
          let present = false
          let verified = false
          const adapter = yield* makeNativeHelperAdapter({
            ...helper.dependencies,
            artifactPresent: () => present,
            verify: () => Effect.succeed(verified),
          })
          const capture = yield* makeAudioCapture({
            daemonInstanceId: "daemon-fixture",
            adapter,
            observations: Stream.never,
            resolver: {
              list: () =>
                Effect.succeed({
                  availability: "available",
                  sources: [source],
                }),
              revalidate: () => Effect.succeed(source),
              confirm: () => Effect.succeed("same"),
            },
          })
          // Listing gates on availability, so a cached verification rejection
          // would make a later install unreachable for the daemon's lifetime.
          expect((yield* capture.listSources("window-a")).availability).toBe(
            "unavailable",
          )
          present = true
          verified = true
          const listed = yield* capture.listSources("window-a")
          expect(listed.availability).toBe("available")
          const token = listed.sources[0]?.token
          if (token === undefined)
            throw new Error("a present helper must issue a selection token")
          const starting = yield* capture
            .start("window-a", token)
            .pipe(Effect.forkChild)
          yield* Latch.await(helper.spawned)
          yield* Queue.offer(helper.input, line(1))
          expect((yield* Fiber.join(starting)).type).toBe("started")
        }),
      ),
    )
  })

  test("a verified helper is usable only after a valid draft; identity uses arguments, and EOF joins exit", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const helper = yield* fakeHelper(false)
          const owner = yield* Scope.make()
          const adapter = yield* makeNativeHelperAdapter(helper.dependencies)
          const starting = yield* Scope.provide(owner)(
            adapter.start(source),
          ).pipe(Effect.forkChild)
          yield* Latch.await(helper.spawned)
          expect(starting.pollUnsafe()).toBeUndefined()
          yield* Queue.offer(helper.input, line(1))
          const handle = yield* Fiber.join(starting)
          const received = yield* Queue.bounded<number>(1)
          const reading = yield* handle.frames.pipe(
            Stream.runForEach((frame) =>
              Queue.offer(received, frame.timestampMs),
            ),
            Effect.forkChild,
          )
          expect(yield* Queue.take(received)).toBe(1)
          // Split a line across chunks to exercise framing, not only JSON decoding.
          const next = line(2)
          yield* Queue.offer(helper.input, next.subarray(0, 7))
          yield* Queue.offer(helper.input, next.subarray(7))
          expect(yield* Queue.take(received)).toBe(2)
          expect(helper.requests[0]).toMatchObject({
            shell: false,
            args: [
              "--protocol",
              "1",
              "--process-id",
              "42",
              "--launch-identity",
              "launch-fixture",
              "--executable-identity",
              "executable-fixture",
              "--core-audio-object",
              "object-fixture",
            ],
          })
          yield* Queue.end(helper.input)
          yield* Effect.yieldNow
          expect(reading.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(helper.exited, { code: 0, signal: null })
          yield* Fiber.join(reading)
          yield* Scope.close(owner, Exit.void)
          expect(
            helper.events.filter((event) => event === "SIGTERM"),
          ).toHaveLength(1)
          expect(helper.exitWaits()).toBeGreaterThan(0)
        }),
      ),
    )
  })

  for (const blocked of ["startup", "stdout", "heartbeat"]) {
    test(`the independent deadline ends blocked ${blocked}, even with a live parent lease`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const clock = yield* TestClock.make()
            yield* Effect.gen(function* () {
              const helper = yield* fakeHelper()
              const owner = yield* Scope.make()
              const adapter = yield* makeNativeHelperAdapter({
                ...helper.dependencies,
                spawn: (request) => ({
                  ...helper.dependencies.spawn(request),
                  ...(blocked === "startup" ? { ready: Effect.never } : {}),
                  ...(blocked === "heartbeat"
                    ? { heartbeat: Effect.never }
                    : {}),
                }),
              })
              const starting = yield* Scope.provide(owner)(
                adapter.start(source),
              ).pipe(Effect.exit, Effect.forkChild)
              yield* Latch.await(helper.spawned)
              yield* clock.adjust("2 seconds")
              if (blocked !== "startup") yield* clock.adjust("2 seconds")
              expect(helper.heartbeats()).toBe(blocked === "stdout" ? 3 : 0)
              yield* clock.adjust(
                blocked === "startup" ? "2999 millis" : "999 millis",
              )
              expect(starting.pollUnsafe()).toBeUndefined()
              expect(helper.events).not.toContain("SIGTERM")
              yield* clock.adjust("1 millis")
              assertFailure(yield* Fiber.join(starting), "timeout")
              yield* Scope.close(owner, Exit.void)
              expect(helper.events).toEqual(
                ["stdout-ended", "stop-io", "SIGTERM"].filter(
                  (event) => blocked !== "startup" || event !== "stdout-ended",
                ),
              )
            }).pipe(Effect.provideService(Clock.Clock, clock))
          }),
        ),
      )
    })
  }

  test("a slow consumer keeps only the latest draft, not an animation history", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const helper = yield* fakeHelper()
          const adapter = yield* makeNativeHelperAdapter(helper.dependencies)
          const starting = yield* adapter.start(source).pipe(Effect.forkChild)
          yield* Latch.await(helper.spawned)
          yield* Queue.offer(helper.input, line())
          const handle = yield* Fiber.join(starting)
          for (let n = 2; n <= 10_000; n++)
            yield* Queue.offer(helper.input, line(n))
          yield* helper.flush
          const latest = yield* handle.frames.pipe(
            Stream.take(1),
            Stream.runCollect,
          )
          expect(latest.map((frame) => frame.timestampMs)).toEqual([10_000])
          expect(helper.requests).toHaveLength(1)
        }),
      ),
    )
  })

  for (const [name, bytes] of [
    [
      "oversized partial line",
      Buffer.alloc(MAX_AUDIO_FEATURE_FRAME_BYTES + 1, 120),
    ],
    ["malformed JSON", Buffer.from("{broken}\n")],
    ["unterminated frame", Buffer.from(JSON.stringify(draft()))],
    [
      "non-finite value",
      Buffer.from(JSON.stringify(draft()).replace("[1]", "[1e400]") + "\n"),
    ],
    [
      "too many bands",
      Buffer.from(
        JSON.stringify({ ...draft(), spectrum: Array(65).fill(0) }) + "\n",
      ),
    ],
    [
      "too many envelope buckets",
      Buffer.from(
        JSON.stringify({
          ...draft(),
          envelope: Array(129).fill({ min: 0, max: 0 }),
        }) + "\n",
      ),
    ],
    [
      "too many channels",
      Buffer.from(
        JSON.stringify({
          ...draft(),
          channels: { layout: "mono", rms: [0, 0, 0], peaks: [0] },
        }) + "\n",
      ),
    ],
  ] as const) {
    test(`${name} ends the session with a typed failure and bounded cleanup`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const helper = yield* fakeHelper()
            const chunks: Uint8Array[] = []
            for (let offset = 0; offset < bytes.length; offset += 1_024)
              chunks.push(bytes.subarray(offset, offset + 1_024))
            const adapter = yield* makeNativeHelperAdapter({
              ...helper.dependencies,
              spawn: (request) => ({
                ...helper.dependencies.spawn(request),
                stdout: Stream.fromIterable(chunks),
              }),
            })
            assertFailure(
              yield* adapter.start(source).pipe(Effect.exit),
              "setup",
            )
            expect(helper.events).toEqual(["stop-io", "SIGTERM"])
          }),
        ),
      )
    })
  }

  test("an active session reports malformed stdout as a stream failure, never a defect", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const helper = yield* fakeHelper()
          const adapter = yield* makeNativeHelperAdapter(helper.dependencies)
          const starting = yield* adapter.start(source).pipe(Effect.forkChild)
          yield* Queue.offer(helper.input, line())
          const handle = yield* Fiber.join(starting)
          yield* Queue.offer(helper.input, Buffer.from("invalid\n"))
          assertFailure(
            yield* handle.frames.pipe(Stream.runDrain, Effect.exit),
            "setup",
          )
          expect(
            helper.events.filter((event) => event === "SIGTERM"),
          ).toHaveLength(1)
        }),
      ),
    )
  })

  test("spawn failure is typed and does not pretend that capture started", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeNativeHelperAdapter({
            artifactPresent: () => true,
            verify: () => Effect.succeed(true),
            spawn: () => {
              throw new Error("offline spawn failure")
            },
          })
          assertFailure(yield* adapter.start(source).pipe(Effect.exit), "setup")
        }),
      ),
    )
  })

  for (const workerStarted of [false, true]) {
    test(`scope close ${workerStarted ? "during output" : "during ownership handoff"} joins blocked termination`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const helper = yield* fakeHelper(false)
            const owner = yield* Scope.make()
            const adapter = yield* makeNativeHelperAdapter(helper.dependencies)
            const starting = yield* Scope.provide(owner)(
              adapter.start(source),
            ).pipe(Effect.exit, Effect.forkChild)
            yield* Latch.await(workerStarted ? helper.reading : helper.spawned)
            const closing = yield* Scope.close(owner, Exit.void).pipe(
              Effect.forkChild,
            )
            yield* Latch.await(helper.signaled)
            expect(closing.pollUnsafe()).toBeUndefined()
            const expected = workerStarted
              ? ["stdout-ended", "stop-io", "SIGTERM"]
              : ["stop-io", "SIGTERM"]
            expect(helper.events).toEqual(expected)
            expect(helper.exitWaits()).toBe(0)
            yield* Deferred.succeed(helper.exited, {
              code: 0,
              signal: null,
            })
            yield* Fiber.join(closing)
            expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true)
            expect(helper.events).toEqual(expected)
            expect(helper.exitWaits()).toBe(1)
          }),
        ),
      )
    })
  }

  for (const failed of [false, true]) {
    test(`concurrent termination callers join the same completed ${failed ? "failure" : "success"}`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const helper = yield* fakeHelper(false)
            const terminate = yield* makeHelperTermination({
              ...helper.process,
              stopIO: () => {
                helper.process.stopIO()
                if (failed) throw new Error("offline I/O teardown failure")
              },
            })
            const first = yield* terminate.pipe(Effect.exit, Effect.forkChild)
            yield* Latch.await(helper.signaled)
            const callers = yield* Effect.forEach(
              Array.from({ length: 8 }),
              () => terminate.pipe(Effect.exit, Effect.forkChild),
            )
            yield* Effect.yieldNow
            expect(first.pollUnsafe()).toBeUndefined()
            for (const caller of callers)
              expect(caller.pollUnsafe()).toBeUndefined()
            expect(helper.events).toEqual(["stop-io", "SIGTERM"])
            yield* Deferred.succeed(helper.exited, {
              code: 0,
              signal: null,
            })
            const completed = yield* Fiber.join(first)
            if (failed) assertFailure(completed, "setup")
            else expect(Exit.isSuccess(completed)).toBe(true)
            for (const caller of callers)
              expect(yield* Fiber.join(caller)).toEqual(completed)
            expect(yield* terminate.pipe(Effect.exit)).toEqual(completed)
            expect(helper.events).toEqual(["stop-io", "SIGTERM"])
            expect(helper.exitWaits()).toBe(1)
          }),
        ),
      )
    })
  }

  for (const exits of [false, true]) {
    test(`hard kill ${exits ? "reaps the helper" : "has its own exit deadline"} and reports abnormal cleanup`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const clock = yield* TestClock.make()
            yield* Effect.gen(function* () {
              const helper = yield* fakeHelper(false)
              const terminate = yield* makeHelperTermination({
                ...helper.process,
                signal: (signal) => {
                  helper.process.signal(signal)
                  if (exits && signal === "SIGKILL")
                    Deferred.doneUnsafe(
                      helper.exited,
                      Effect.succeed({ code: null, signal }),
                    )
                },
              })
              const closing = yield* terminate.pipe(
                Effect.exit,
                Effect.forkChild,
              )
              yield* Latch.await(helper.signaled)
              yield* clock.adjust("1 second")
              if (!exits) {
                expect(closing.pollUnsafe()).toBeUndefined()
                yield* clock.adjust("1 second")
              }
              assertFailure(
                yield* Fiber.join(closing),
                exits ? "setup" : "timeout",
              )
              assertFailure(
                yield* terminate.pipe(Effect.exit),
                exits ? "setup" : "timeout",
              )
              expect(helper.events).toEqual(["stop-io", "SIGTERM", "SIGKILL"])
              expect(helper.exitWaits()).toBe(exits ? 1 : 0)
            }).pipe(Effect.provideService(Clock.Clock, clock))
          }),
        ),
      )
    })
  }

  test("active output loss expires from the last valid frame, not a partial line or heartbeat", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          yield* Effect.gen(function* () {
            const helper = yield* fakeHelper()
            const adapter = yield* makeNativeHelperAdapter(helper.dependencies)
            const starting = yield* adapter.start(source).pipe(Effect.forkChild)
            yield* Queue.offer(helper.input, line())
            const handle = yield* Fiber.join(starting)
            const reading = yield* handle.frames.pipe(
              Stream.runDrain,
              Effect.exit,
              Effect.forkChild,
            )
            yield* clock.adjust("4 seconds")
            yield* Queue.offer(helper.input, Buffer.from("{"))
            yield* helper.flush
            yield* clock.adjust("1 second")
            assertFailure(yield* Fiber.join(reading), "timeout")
            expect(helper.heartbeats()).toBe(3)
            expect(helper.events).toEqual([
              "stdout-ended",
              "stop-io",
              "SIGTERM",
            ])
          }).pipe(Effect.provideService(Clock.Clock, clock))
        }),
      ),
    )
  })

  test("valid frames renew the output deadline without validating owner sequence or generation here", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          yield* Effect.gen(function* () {
            const helper = yield* fakeHelper()
            const adapter = yield* makeNativeHelperAdapter(helper.dependencies)
            const starting = yield* adapter.start(source).pipe(Effect.forkChild)
            yield* Queue.offer(helper.input, line(2))
            const handle = yield* Fiber.join(starting)
            yield* clock.adjust("4 seconds")
            yield* Queue.offer(helper.input, line(1))
            yield* helper.flush
            yield* clock.adjust("4 seconds")
            expect(helper.events).not.toContain("SIGTERM")
            const frames = yield* handle.frames.pipe(
              Stream.take(1),
              Stream.runCollect,
            )
            expect(frames.map((frame) => frame.timestampMs)).toEqual([1])
          }).pipe(Effect.provideService(Clock.Clock, clock))
        }),
      ),
    )
  })

  for (const reason of ["setup", "permission"] as const) {
    test(`asynchronous readiness failure stays typed as ${reason}`, async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const helper = yield* fakeHelper()
            const adapter = yield* makeNativeHelperAdapter({
              ...helper.dependencies,
              spawn: (request) => ({
                ...helper.dependencies.spawn(request),
                ready: Effect.fail(new AudioAdapterError({ reason })),
              }),
            })
            assertFailure(
              yield* adapter.start(source).pipe(Effect.exit),
              reason,
            )
            expect(helper.events).toEqual(["stop-io", "SIGTERM"])
          }),
        ),
      )
    })
  }

  test("stderr is bounded diagnostic-only input and cannot claim permission failure", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const helper = yield* fakeHelper()
          const drained = yield* Latch.make(false)
          const adapter = yield* makeNativeHelperAdapter({
            ...helper.dependencies,
            spawn: (request) => ({
              ...helper.dependencies.spawn(request),
              stderr: Stream.fromIterable(
                Array.from({ length: 10_000 }, () =>
                  Buffer.from('{"reason":"permission"}\\n'),
                ),
              ).pipe(
                Stream.concat(
                  Stream.fromEffect(Latch.open(drained)).pipe(Stream.drain),
                ),
                Stream.concat(Stream.never),
              ),
            }),
          })
          const starting = yield* adapter.start(source).pipe(Effect.forkChild)
          yield* Latch.await(drained)
          yield* Queue.offer(helper.input, line())
          const handle = yield* Fiber.join(starting)
          expect(
            yield* handle.frames.pipe(Stream.take(1), Stream.runCollect),
          ).toHaveLength(1)
          expect(helper.events).not.toContain("SIGTERM")
        }),
      ),
    )
  })

  test("a cancelled termination waiter still joins physical exit and cannot trigger another signal", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const helper = yield* fakeHelper(false)
          const terminate = yield* makeHelperTermination(helper.process)
          const leader = yield* terminate.pipe(Effect.forkChild)
          yield* Latch.await(helper.signaled)
          const entered = yield* Latch.make(false)
          const waiter = yield* Latch.open(entered).pipe(
            Effect.andThen(terminate),
            Effect.forkChild,
          )
          yield* Latch.await(entered)
          const interrupting = yield* Fiber.interrupt(waiter).pipe(
            Effect.forkChild,
          )
          yield* Effect.yieldNow
          expect(interrupting.pollUnsafe()).toBeUndefined()
          expect(helper.events).toEqual(["stop-io", "SIGTERM"])
          yield* Deferred.succeed(helper.exited, {
            code: 0,
            signal: null,
          })
          yield* Fiber.join(leader)
          yield* Fiber.join(interrupting)
          expect(helper.exitWaits()).toBe(1)
          expect(helper.events).toEqual(["stop-io", "SIGTERM"])
        }),
      ),
    )
  })

  test("owning scope reports a hard-killed helper as failed cleanup, never successful closure", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          yield* Effect.gen(function* () {
            const helper = yield* fakeHelper(false)
            const owner = yield* Scope.make()
            const adapter = yield* makeNativeHelperAdapter({
              ...helper.dependencies,
              spawn: (request) => ({
                ...helper.dependencies.spawn(request),
                signal: (signal) => {
                  helper.process.signal(signal)
                  if (signal === "SIGKILL")
                    Deferred.doneUnsafe(
                      helper.exited,
                      Effect.succeed({ code: null, signal }),
                    )
                },
              }),
            })
            const starting = yield* Scope.provide(owner)(
              adapter.start(source),
            ).pipe(Effect.forkChild)
            yield* Queue.offer(helper.input, line())
            yield* Fiber.join(starting)
            const closing = yield* Scope.close(owner, Exit.void).pipe(
              Effect.exit,
              Effect.forkChild,
            )
            yield* Latch.await(helper.signaled)
            yield* clock.adjust("1 second")
            const result = yield* Fiber.join(closing)
            expect(Exit.isFailure(result)).toBe(true)
            if (Exit.isSuccess(result))
              throw new Error("hard kill must fail scope closure")
            const defect = Cause.findDefect(result.cause)
            expect(Result.isSuccess(defect)).toBe(true)
            if (
              Result.isFailure(defect) ||
              !(defect.success instanceof AudioAdapterError)
            )
              throw new Error("missing abnormal cleanup error")
            expect(defect.success.reason).toBe("setup")
            expect(helper.events).toEqual([
              "stdout-ended",
              "stop-io",
              "SIGTERM",
              "SIGKILL",
            ])
          }).pipe(Effect.provideService(Clock.Clock, clock))
        }),
      ),
    )
  })

  test("an abnormal exit ends even blocked stdout with a typed setup failure", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const helper = yield* fakeHelper(false)
          const adapter = yield* makeNativeHelperAdapter(helper.dependencies)
          const starting = yield* adapter.start(source).pipe(Effect.forkChild)
          yield* Queue.offer(helper.input, line())
          const handle = yield* Fiber.join(starting)
          yield* Deferred.succeed(helper.exited, { code: 7, signal: null })
          assertFailure(
            yield* handle.frames.pipe(Stream.runDrain, Effect.exit),
            "setup",
          )
          expect(helper.events).toEqual(["stdout-ended", "stop-io", "SIGTERM"])
        }),
      ),
    )
  })
})
