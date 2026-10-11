import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Deferred, Effect, Fiber, Stream } from "effect"
import {
  helperError,
  type NativeHelperDependencies,
  type NativeHelperExit,
  type NativeHelperProcess,
} from "../../audio/helper-process.ts"
import { sckHelperIdentifier, sckHelperPath } from "./adapter.ts"
import { inspectSourceDiscovery } from "./discovery-check.ts"
import { sourceDiscovery } from "./source-discovery.ts"

const identity = {
  kind: "native",
  processIdentifier: 42,
  launchIdentity: "100:0",
  executableIdentity: "/fixture|abcdef12",
  coreAudioObject: "99",
}
const summary = {
  event: "sck-source-discovery",
  identityChecks: "passed-before-and-after",
  attributionChecks: "passed-before-and-after",
  matchingApplications: 0,
  displayCount: 1,
} as const

function fixture(
  options: {
    count?: number
    payload?: string
    code?: number
    fault?: "stdout" | "heartbeat" | "cleanup"
    pending?: boolean
  } = {},
) {
  const events: string[] = []
  const spawned = Deferred.makeUnsafe<void>()
  const exit = Deferred.makeUnsafe<NativeHelperExit>()
  if (!options.pending)
    Deferred.doneUnsafe(
      exit,
      Effect.succeed({ code: options.code ?? 0, signal: null }),
    )
  const child: NativeHelperProcess = {
    ready: Effect.void,
    stdout:
      options.fault === "stdout"
        ? Stream.fail(helperError())
        : options.pending || options.fault === "heartbeat"
          ? Stream.never
          : Stream.make(
              Buffer.from(options.payload ?? JSON.stringify(summary)),
            ),
    stderr:
      options.code === 77
        ? Stream.make(
            Buffer.from(
              '{"event":"music-audio-helper-stop","reason":"permission"}\n',
            ),
          )
        : Stream.empty,
    exit: Deferred.await(exit),
    heartbeat:
      options.fault === "heartbeat" ? Effect.fail(helperError()) : Effect.void,
    stopIO: () => {
      events.push("stop-io")
      if (options.fault === "cleanup")
        throw new Error("synthetic cleanup failure")
    },
    signal: (signal) => {
      events.push(signal)
      Deferred.doneUnsafe(exit, Effect.succeed({ code: 0, signal: null }))
    },
  }
  const boundary: NativeHelperDependencies = {
    artifactPresent: () => true,
    verify: (path, identifier) =>
      Effect.sync(() => {
        expect(path).toBe(sckHelperPath)
        expect(identifier).toBe(sckHelperIdentifier)
        return true
      }),
    spawn: (request) => {
      expect(request.executable).toBe(sckHelperPath)
      expect(request.shell).toBe(false)
      if (request.args[0] === "--list-kaset-sources") {
        events.push("catalog")
        return {
          ...child,
          stdout: Stream.make(
            Buffer.from(
              JSON.stringify({
                sources: Array.from({ length: options.count ?? 1 }, () => ({
                  identity,
                  runningOutput: false,
                })),
              }),
            ),
          ),
          stderr: Stream.empty,
          exit: Effect.succeed({ code: 0, signal: null }),
          heartbeat: Effect.void,
          stopIO: () => {},
          signal: () => {},
        }
      }
      expect(request.args).toEqual([
        sourceDiscovery.nativeFlag,
        "--protocol",
        "1",
        "--process-id",
        "42",
        "--launch-identity",
        "100:0",
        "--executable-identity",
        "/fixture|abcdef12",
        "--core-audio-object",
        "99",
        "--attribution",
        "kaset-cache-v1",
      ])
      events.push("discovery")
      Deferred.doneUnsafe(spawned, Effect.void)
      return child
    },
  }
  const claim = Effect.sync(() => {
    events.push("claim")
  })
  return { boundary, claim, events, spawned }
}

test("a paused verified source can report a stable missing application using only discovery", async () => {
  const setup = fixture({
    payload: JSON.stringify({
      ...summary,
      privateWindowTitle: "must not persist",
    }),
  })
  const result = await Effect.runPromise(
    inspectSourceDiscovery(setup.claim, setup.boundary),
  )
  expect(result).toEqual({ status: "checked", summary, nativeDiagnostics: [] })
  expect(JSON.stringify(result)).not.toContain("must not persist")
  expect(setup.events).toEqual([
    "catalog",
    "claim",
    "discovery",
    "stop-io",
    "SIGTERM",
  ])
})

test("missing or ambiguous metadata does not claim an attempt or query ScreenCaptureKit", async () => {
  for (const count of [0, 2]) {
    const setup = fixture({ count })
    const result = await Effect.runPromise(
      inspectSourceDiscovery(setup.claim, setup.boundary),
    )
    expect(result.status).toBe("unavailable")
    expect(setup.events).toEqual(["catalog"])
  }
})

test("invalid or oversized native summaries cannot become checked discovery evidence", async () => {
  for (const payload of [
    JSON.stringify({ ...summary, matchingApplications: -1 }),
    JSON.stringify({ ...summary, identityChecks: "failed" }),
    "x".repeat(4097),
  ]) {
    const setup = fixture({ payload })
    const result = await Effect.runPromise(
      inspectSourceDiscovery(setup.claim, setup.boundary),
    )
    expect(result.status).toBe("failed")
    expect(JSON.stringify(result)).not.toContain(payload)
    expect(setup.events.slice(-2)).toEqual(["stop-io", "SIGTERM"])
  }
})

test("confirmed native denial survives discovery stdout and heartbeat failures", async () => {
  for (const fault of [undefined, "stdout", "heartbeat"] as const) {
    const setup = fixture({ code: 77, ...(fault ? { fault } : {}) })
    const result = await Effect.runPromise(
      inspectSourceDiscovery(setup.claim, setup.boundary),
    )
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("denial became checked")
    expect(result.reason).toBe("permission")
    expect(result.nativeDiagnostics).toEqual([
      { command: "discovery", reason: "permission" },
    ])
  }
})

test("cleanup failure supersedes native denial instead of claiming successful release", async () => {
  const setup = fixture({ code: 77, fault: "cleanup" })
  const result = await Effect.runPromise(
    inspectSourceDiscovery(setup.claim, setup.boundary),
  )
  expect(result.status).toBe("failed")
  if (result.status !== "failed")
    throw new Error("cleanup failure became checked")
  expect(result.reason).toBe("cleanup-failed")
  expect(setup.events.slice(-2)).toEqual(["stop-io", "SIGTERM"])
})

test("a rejected attempt claim prevents the protected discovery command", async () => {
  const setup = fixture()
  const result = await Effect.runPromise(
    inspectSourceDiscovery(
      Effect.fail(helperError("unavailable")),
      setup.boundary,
    ),
  )
  expect(result.status).toBe("failed")
  expect(setup.events).toEqual(["catalog"])
})

test("cancellation joins physical helper exit without returning checked evidence", async () => {
  const setup = fixture({ pending: true })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* inspectSourceDiscovery(
          setup.claim,
          setup.boundary,
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(setup.spawned)
        yield* Fiber.interrupt(fiber)
        const outcome = yield* Fiber.await(fiber)
        expect(outcome._tag).toBe("Failure")
      }),
    ),
  )
  expect(setup.events.slice(-2)).toEqual(["stop-io", "SIGTERM"])
})
