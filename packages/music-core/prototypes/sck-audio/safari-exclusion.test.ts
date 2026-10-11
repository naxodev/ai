import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { helperError } from "../../audio/helper-process.ts"
import { makeApplicationFixture } from "./application-test-fixture.ts"
import { safariExclusion } from "./safari-exclusion.ts"
import { inspectSafariExclusion } from "./safari-exclusion-check.ts"

const safari = {
  event: "sck-safari-preflight",
  scope: "safari-application",
  identity: {
    processIdentifier: 27182,
    launchIdentity: "300:0",
    executableIdentity:
      "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari|" +
      "b".repeat(40),
  },
}
const summary = {
  event: "sck-safari-exclusion",
  scope: "kaset-paused-safari-marker",
  verification: "passed-throughout",
  streamsStarted: 2,
  cleanup: "joined",
  windows: 60,
  referenceWindows: 60,
  violations: 0,
  clippedWindows: 0,
  targetTotalMax: 0,
  targetMarkerMax: 0,
  referenceTotalMax: 0.005,
  referenceMarkerMin: 0.005,
  referenceMarkerMax: 0.005,
  isolationEstablished: false,
} as const
function fixture(options: Parameters<typeof makeApplicationFixture>[2] = {}) {
  return makeApplicationFixture(
    { ...safariExclusion, preflightFlag: "--check-kaset-application" },
    summary,
    {
      ...options,
      metadata: options.metadata ?? {
        [safariExclusion.preflightFlag]: JSON.stringify(safari),
      },
    },
  )
}
test("paired scopes and a positive Safari control establish only the paused-target exclusion case", async () => {
  const setup = fixture()
  const result = await Effect.runPromise(
    inspectSafariExclusion(setup.claim, setup.boundary),
  )
  expect(result.status).toBe("checked")
  if (result.status !== "checked") throw new Error("paired capture failed")
  expect(result.summary).toEqual({
    ...summary,
    verdict: "passed",
    reason: "paused-target-exclusion",
  })
  expect(setup.calls.map((args) => args[0])).toEqual([
    "--list-kaset-sources",
    "--check-kaset-application",
    safariExclusion.preflightFlag,
    safariExclusion.nativeFlag,
  ])
  expect(setup.calls[3]).toHaveLength(25)
  expect(setup.events[0]).toBe("claim")
  expect(JSON.stringify(result)).not.toContain("27182")
  expect(JSON.stringify(result)).not.toContain("privatePath")
})
test("missing, ambiguous, or spoofed identities cannot claim a paired capture", async () => {
  for (const options of [
    { witnesses: 0 },
    { witnesses: 2 },
    { trusted: false },
    {
      metadata: {
        [safariExclusion.preflightFlag]: JSON.stringify({
          ...safari,
          scope: "process",
        }),
      },
    },
    {
      metadata: {
        [safariExclusion.preflightFlag]: JSON.stringify({
          ...safari,
          identity: {
            ...safari.identity,
            executableIdentity: "/Applications/Fake.app|" + "b".repeat(40),
          },
        }),
      },
    },
  ]) {
    const setup = fixture(options)
    const result = await Effect.runPromise(
      inspectSafariExclusion(setup.claim, setup.boundary),
    )
    expect(result.status).not.toBe("checked")
    expect(setup.events).not.toContain("claim")
    expect(
      setup.calls.some((args) => args[0] === safariExclusion.nativeFlag),
    ).toBe(false)
  }
})
test("a spent attempt prevents both protected streams after eligible metadata", async () => {
  const setup = fixture()
  const result = await Effect.runPromise(
    inspectSafariExclusion(
      Effect.fail(helperError("unavailable")),
      setup.boundary,
    ),
  )
  expect(result.status).toBe("failed")
  expect(setup.calls).toHaveLength(3)
})
test("missing coverage, contamination, or clipping stays inconclusive even with target silence", async () => {
  for (const [patch, reason] of [
    [{ windows: 59, referenceWindows: 59 }, "incomplete-coverage"],
    [{ referenceWindows: 59 }, "invalid-reference"],
    [{ clippedWindows: 1 }, "clipped-samples"],
    [
      { referenceWindows: 0, referenceTotalMax: 0, referenceMarkerMin: 0 },
      "invalid-reference",
    ],
  ] as const) {
    const setup = fixture({ payload: JSON.stringify({ ...summary, ...patch }) })
    const result = await Effect.runPromise(
      inspectSafariExclusion(setup.claim, setup.boundary),
    )
    expect(result.status).toBe("checked")
    if (result.status !== "checked")
      throw new Error("inconclusive control was discarded")
    expect(result.summary.verdict).toBe("inconclusive")
    expect(result.summary.reason).toBe(reason)
  }
})
test("an exceeded target limit fails the case without claiming the audio's origin", async () => {
  const setup = fixture({
    payload: JSON.stringify({
      ...summary,
      violations: 1,
      targetTotalMax: 0.001,
    }),
  })
  const result = await Effect.runPromise(
    inspectSafariExclusion(setup.claim, setup.boundary),
  )
  expect(result.status).toBe("checked")
  if (result.status !== "checked")
    throw new Error("valid measured failure discarded")
  expect(result.summary.verdict).toBe("failed")
  expect(result.summary.reason).toBe("target-energy-limit")
  expect(result.summary.isolationEstablished).toBe(false)
})
test("contradictory summaries cannot turn missing streams or cleanup into exclusion evidence", async () => {
  for (const patch of [
    { streamsStarted: 1 },
    { cleanup: "failed" },
    { isolationEstablished: true },
    { scope: "system" },
    { windows: 61 },
    { referenceWindows: 61 },
    { referenceWindows: 0, violations: 1 },
    { clippedWindows: 61 },
    { referenceMarkerMin: 0 },
    { referenceTotalMax: 0 },
    { targetMarkerMax: -1 },
    { targetTotalMax: 1 },
    { referenceMarkerMax: 0 },
    { windows: 0, referenceWindows: 0 },
  ]) {
    const setup = fixture({ payload: JSON.stringify({ ...summary, ...patch }) })
    expect(
      (
        await Effect.runPromise(
          inspectSafariExclusion(setup.claim, setup.boundary),
        )
      ).status,
    ).toBe("failed")
  }
})
test("paired cleanup failure supersedes denial and native exits survive pipe races", async () => {
  for (const [code, fault, reason] of [
    [77, undefined, "permission"],
    [77, "stdout", "permission"],
    [77, "heartbeat", "permission"],
    [70, undefined, "cleanup-failed"],
    [70, "stdout", "cleanup-failed"],
    [77, "cleanup", "cleanup-failed"],
  ] as const) {
    const setup = fixture({ code, ...(fault ? { fault } : {}) })
    const result = await Effect.runPromise(
      inspectSafariExclusion(setup.claim, setup.boundary),
    )
    expect(result.status).toBe("failed")
    if (result.status !== "failed")
      throw new Error("failed cleanup became checked")
    expect(result.reason).toBe(reason)
  }
})
test("cancelling a paired attempt joins the physical helper and emits no summary", async () => {
  const setup = fixture({ pending: true })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* inspectSafariExclusion(
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
