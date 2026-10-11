import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { helperError } from "../../audio/helper-process.ts"
import { inspectApplicationDiscovery } from "./application-check.ts"
import { applicationDiscovery } from "./application-discovery.ts"
import {
  makeApplicationFixture,
  witness,
  application,
  preflight,
} from "./application-test-fixture.ts"
const summary = {
  event: "sck-application-discovery",
  scope: "kaset-application",
  applicationChecks: "passed-before-and-after",
  witnessChecks: "passed-before-and-after",
  matchingApplications: 1,
  witnessMatches: 0,
  displayCount: 2,
} as const

const fixture = (options: Parameters<typeof makeApplicationFixture>[2] = {}) =>
  makeApplicationFixture(applicationDiscovery, summary, options)

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
