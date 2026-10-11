import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Deferred, Effect, Fiber, Stream } from "effect"
import {
  helperError,
  type NativeHelperDependencies,
  type NativeHelperExit,
  type NativeHelperProcess,
} from "../../audio/helper-process.ts"
import { inspectApplicationDiscovery } from "./application-check.ts"
import { applicationDiscovery } from "./application-discovery.ts"

const witness = {
  kind: "native",
  processIdentifier: 42,
  launchIdentity: "100:0",
  executableIdentity: "/fixture|abcdef12",
  coreAudioObject: "99",
}
const application = {
  processIdentifier: 31415,
  launchIdentity: "200:0",
  executableIdentity:
    "/Applications/Kaset.app/Contents/MacOS/Kaset|" + "a".repeat(40),
}
const preflight = {
  event: "sck-application-preflight",
  scope: "kaset-application",
  identity: application,
}
const summary = {
  event: "sck-application-discovery",
  scope: "kaset-application",
  applicationChecks: "passed-before-and-after",
  witnessChecks: "passed-before-and-after",
  matchingApplications: 1,
  witnessMatches: 0,
  displayCount: 2,
} as const

function fixture(
  options: {
    witnesses?: number
    preflight?: string
    payload?: string
    code?: number
    fault?: "stdout" | "heartbeat" | "cleanup"
    pending?: boolean
    trusted?: boolean
  } = {},
) {
  const calls: string[][] = []
  const events: string[] = []
  const spawned = Deferred.makeUnsafe<void>()
  const exit = Deferred.makeUnsafe<NativeHelperExit>()
  if (!options.pending)
    Deferred.doneUnsafe(
      exit,
      Effect.succeed({ code: options.code ?? 0, signal: null }),
    )
  const completed = (payload: string): NativeHelperProcess => ({
    ready: Effect.void,
    stdout: Stream.make(Buffer.from(payload)),
    stderr: Stream.empty,
    exit: Effect.succeed({ code: 0, signal: null }),
    heartbeat: Effect.void,
    stopIO: () => {},
    signal: () => {},
  })
  const child: NativeHelperProcess = {
    ...completed(
      options.payload ??
        JSON.stringify({ ...summary, privatePath: "/private/window/title" }),
    ),
    stdout:
      options.fault === "stdout"
        ? Stream.fail(helperError())
        : options.pending || options.fault === "heartbeat"
          ? Stream.never
          : Stream.make(
              Buffer.from(
                options.payload ??
                  JSON.stringify({
                    ...summary,
                    privatePath: "/private/window/title",
                  }),
              ),
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
      if (options.fault === "cleanup") throw new Error("cleanup failed")
    },
    signal: (signal) => {
      events.push(signal)
      Deferred.doneUnsafe(exit, Effect.succeed({ code: null, signal }))
    },
  }
  const boundary: NativeHelperDependencies = {
    artifactPresent: () => true,
    verify: (path, identifier) =>
      Effect.sync(() => {
        expect(path).toBe(applicationDiscovery.helperPath)
        expect(identifier).toBe(applicationDiscovery.helperIdentifier)
        return options.trusted !== false
      }),
    spawn: (request) => {
      expect(request.executable).toBe(applicationDiscovery.helperPath)
      expect(request.shell).toBe(false)
      calls.push([...request.args])
      if (request.args[0] === "--list-kaset-sources")
        return completed(
          JSON.stringify({
            sources: Array.from({ length: options.witnesses ?? 1 }, () => ({
              identity: witness,
              runningOutput: false,
            })),
          }),
        )
      if (request.args[0] === applicationDiscovery.preflightFlag)
        return completed(options.preflight ?? JSON.stringify(preflight))
      expect(request.args[0]).toBe(applicationDiscovery.nativeFlag)
      Deferred.doneUnsafe(spawned, Effect.void)
      return child
    },
  }
  return {
    boundary,
    calls,
    events,
    spawned,
    claim: Effect.sync(() => {
      events.push("claim")
    }),
  }
}

test("application discovery uses the pinned helper and preserves both preflight identities without retaining them", async () => {
  const setup = fixture()
  const result = await Effect.runPromise(
    inspectApplicationDiscovery(setup.claim, setup.boundary),
  )
  expect(result.status).toBe("checked")
  if (result.status !== "checked")
    throw new Error("application discovery failed")
  expect(result.summary).toEqual(summary)
  expect(setup.calls.map((args) => args[0])).toEqual([
    "--list-kaset-sources",
    applicationDiscovery.preflightFlag,
    applicationDiscovery.nativeFlag,
  ])
  expect(setup.calls[2]).toContain(String(witness.processIdentifier))
  expect(setup.calls[2]?.slice(-6)).toEqual([
    "--application-id",
    String(application.processIdentifier),
    "--application-launch",
    application.launchIdentity,
    "--application-executable",
    application.executableIdentity,
  ])
  expect(JSON.stringify(result)).not.toContain("privatePath")
  expect(JSON.stringify(result)).not.toContain("31415")
  expect(JSON.stringify(result)).not.toContain(application.executableIdentity)
  expect(setup.events[0]).toBe("claim")
})

test("missing or ambiguous witnesses prevent application preflight and the protected query", async () => {
  for (const witnesses of [0, 2]) {
    const setup = fixture({ witnesses })
    const result = await Effect.runPromise(
      inspectApplicationDiscovery(setup.claim, setup.boundary),
    )
    expect(result.status).toBe("unavailable")
    expect(setup.calls.map((args) => args[0])).toEqual(["--list-kaset-sources"])
    expect(setup.events).not.toContain("claim")
  }
})

test("untrusted helpers and invalid application proofs cannot claim an attempt", async () => {
  const untrusted = fixture({ trusted: false })
  expect(
    (
      await Effect.runPromise(
        inspectApplicationDiscovery(untrusted.claim, untrusted.boundary),
      )
    ).status,
  ).toBe("failed")
  expect(untrusted.calls).toHaveLength(0)
  for (const payload of [
    "x".repeat(4097),
    JSON.stringify({ ...preflight, scope: "process" }),
    JSON.stringify({
      ...preflight,
      identity: { ...application, processIdentifier: 0 },
    }),
    JSON.stringify({
      ...preflight,
      identity: {
        ...application,
        executableIdentity: "/other/Kaset|" + "a".repeat(40),
      },
    }),
  ]) {
    const setup = fixture({ preflight: payload })
    expect(
      (
        await Effect.runPromise(
          inspectApplicationDiscovery(setup.claim, setup.boundary),
        )
      ).status,
    ).toBe("unavailable")
    expect(setup.calls).toHaveLength(2)
    expect(setup.events).not.toContain("claim")
  }
})

test("an absent, ambiguous, or malformed application result cannot establish eligibility", async () => {
  for (const payload of [
    JSON.stringify({ ...summary, matchingApplications: 0 }),
    JSON.stringify({ ...summary, matchingApplications: 2 }),
    JSON.stringify({ ...summary, displayCount: 0 }),
    JSON.stringify({ ...summary, witnessMatches: -1 }),
    JSON.stringify({ ...summary, applicationChecks: "failed" }),
    "x".repeat(4097),
  ]) {
    const setup = fixture({ payload })
    const result = await Effect.runPromise(
      inspectApplicationDiscovery(setup.claim, setup.boundary),
    )
    expect(result.status).toBe("failed")
    expect(JSON.stringify(result)).not.toContain(payload)
    expect(setup.events).toContain("claim")
  }
})

test("a rejected one-shot claim prevents application discovery after metadata succeeds", async () => {
  const setup = fixture()
  const result = await Effect.runPromise(
    inspectApplicationDiscovery(
      Effect.fail(helperError("unavailable")),
      setup.boundary,
    ),
  )
  expect(result.status).toBe("failed")
  expect(setup.calls).toHaveLength(2)
})

test("confirmed application denial survives pipe races while cleanup failure takes precedence", async () => {
  for (const fault of [undefined, "stdout", "heartbeat", "cleanup"] as const) {
    const setup = fixture({ code: 77, ...(fault ? { fault } : {}) })
    const result = await Effect.runPromise(
      inspectApplicationDiscovery(setup.claim, setup.boundary),
    )
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("denial became checked")
    expect(result.reason).toBe(
      fault === "cleanup" ? "cleanup-failed" : "permission",
    )
    expect(result.nativeDiagnostics).toEqual([
      { command: "discovery", reason: "permission" },
    ])
  }
})

test("application discovery cancellation joins physical exit and emits no checked evidence", async () => {
  const setup = fixture({ pending: true })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* inspectApplicationDiscovery(
          setup.claim,
          setup.boundary,
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(setup.spawned)
        yield* Fiber.interrupt(fiber)
        expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
      }),
    ),
  )
  expect(setup.events.slice(-2)).toEqual(["stop-io", "SIGTERM"])
})
