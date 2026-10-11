import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Deferred, Effect, Stream } from "effect"
import type { NativeHelperDependencies } from "../../audio/helper-process.ts"
import { withProbeDiagnostics, type ProbeDiagnostic } from "./diagnostics.ts"

function fixture(chunks: string[]) {
  const child = {
    ready: Effect.void,
    stdout: Stream.empty,
    stderr: Stream.fromIterable(chunks.map((chunk) => Buffer.from(chunk))),
    exit: Effect.succeed({ code: 1, signal: null }),
    heartbeat: Effect.void,
    stopIO: () => {},
    signal: () => {},
  }
  const boundary: NativeHelperDependencies = {
    artifactPresent: () => true,
    verify: () => Effect.succeed(true),
    spawn: () => child,
  }
  const recorded: ProbeDiagnostic[] = []
  const observer = withProbeDiagnostics(boundary, (value) =>
    recorded.push(value),
  )
  return { child, observer, recorded }
}

test("diagnostics reveal source loss once without changing the helper exit", async () => {
  const message = '{"event":"music-audio-helper-stop","reason":"source-loss"}\n'
  const { child, observer, recorded } = fixture([
    message.slice(0, 20),
    message.slice(20),
  ])
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observed = (yield* observer).spawn({
          executable: "/fixture",
          args: ["--protocol", "1"],
          shell: false,
        })
        const chunks = yield* observed.stderr.pipe(Stream.runCollect)
        expect(chunks).toEqual([])
        expect(recorded).toEqual([
          { command: "capture", reason: "source-loss" },
        ])
        expect(observed.stdout).toBe(child.stdout)
        expect(observed.signal).toBe(child.signal)
        expect(yield* observed.exit).toEqual({ code: 1, signal: null })
        expect(recorded).toHaveLength(1)
      }),
    ),
  )
})

test("slow diagnostic cleanup cannot delay confirmation of physical helper exit", async () => {
  const { child } = fixture([])
  const releaseCleanup = Deferred.makeUnsafe<void>()
  const cleanupStarted = Deferred.makeUnsafe<void>()
  let cleanupFinished = false
  // Escape guard for a broken implementation; the assertion uses a held gate.
  const guard = setTimeout(
    () => Deferred.doneUnsafe(releaseCleanup, Effect.void),
    1000,
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const observer = yield* withProbeDiagnostics(
            {
              artifactPresent: () => true,
              verify: () => Effect.succeed(true),
              spawn: () => ({
                ...child,
                stderr: Stream.never.pipe(
                  Stream.ensuring(
                    Effect.gen(function* () {
                      yield* Deferred.succeed(cleanupStarted, undefined)
                      yield* Deferred.await(releaseCleanup)
                      cleanupFinished = true
                    }),
                  ),
                ),
              }),
            },
            () => {},
          )
          const observed = observer.spawn({
            executable: "/fixture",
            args: [],
            shell: false,
          })
          const exit = yield* observed.exit.pipe(Effect.timeout("250 millis"))
          expect(exit).toEqual({ code: 1, signal: null })
          yield* Deferred.await(cleanupStarted)
          expect(cleanupFinished).toBe(false)
          yield* Deferred.succeed(releaseCleanup, undefined)
        }),
      ),
    )
    expect(cleanupFinished).toBe(true)
  } finally {
    Deferred.doneUnsafe(releaseCleanup, Effect.void)
    clearTimeout(guard)
  }
})

test("private or malformed diagnostic text cannot enter retained evidence", async () => {
  const { observer, recorded } = fixture([
    "private application and window text\n",
    '{"event":"music-audio-helper-stop","reason":"private-title"}\n',
    '{"event":"music-audio-helper-stop","reason":"setup","private":"text"}\n',
    "x".repeat(257) + "\n",
    '{"event":"music-audio-helper-stop","reason":"permission"}\n',
  ])
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observed = (yield* observer).spawn({
          executable: "/fixture",
          args: ["--list-kaset-sources"],
          shell: false,
        })
        yield* observed.stderr.pipe(Stream.runDrain)
        expect(recorded).toEqual([{ command: "catalog", reason: "permission" }])
      }),
    ),
  )
})

test("an unbounded stderr producer cannot create an unbounded evidence record", async () => {
  const message = '{"event":"music-audio-helper-stop","reason":"setup"}\n'
  const { observer, recorded } = fixture(["x".repeat(4096), "\n" + message])
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observed = (yield* observer).spawn({
          executable: "/fixture",
          args: [],
          shell: false,
        })
        yield* observed.stderr.pipe(Stream.runDrain)
        expect(recorded).toEqual([])
      }),
    ),
  )
})
