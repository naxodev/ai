import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { helperError } from "../../audio/helper-process.ts"
import { applicationCapture } from "./application-capture.ts"
import {
  classifyCaptureAvailability,
  inspectApplicationCapture,
} from "./application-capture-check.ts"
import {
  makeApplicationFixture,
  preflight,
} from "./application-test-fixture.ts"

const summary = {
  event: "sck-application-feasibility",
  scope: "kaset-application",
  verification: "passed-throughout",
  streamStarted: true,
  cleanup: "joined",
  matchingApplications: 1,
  frames: 10,
  signalFrames: 4,
  peakRms: 0.1,
  sampleSpanMs: 600,
  isolationEstablished: false,
} as const
const fixture = (options: Parameters<typeof makeApplicationFixture>[2] = {}) =>
  makeApplicationFixture(applicationCapture, summary, options)

test("a clean measured application result reports signal availability without claiming isolation", async () => {
  const setup = fixture()
  const result = await Effect.runPromise(
    inspectApplicationCapture(setup.claim, setup.boundary),
  )
  expect(result.status).toBe("checked")
  if (result.status !== "checked") throw new Error("measured capture failed")
  expect(result.summary).toEqual({
    ...summary,
    availability: "signal-observed",
    availabilityReason: "measured-energy",
  })
  expect(setup.calls.map((args) => args[0])).toEqual([
    "--list-kaset-sources",
    applicationCapture.preflightFlag,
    applicationCapture.nativeFlag,
  ])
  expect(setup.events[0]).toBe("claim")
  expect(JSON.stringify(result)).not.toContain("privatePath")
  expect(JSON.stringify(result)).not.toContain("31415")
})

test("measured silence stays silence while sparse or weak measurements remain inconclusive", () => {
  expect(
    classifyCaptureAvailability({
      frames: 3,
      signalFrames: 3,
      peakRms: 0.0001,
      sampleSpanMs: 500,
    }),
  ).toEqual({
    availability: "signal-observed",
    availabilityReason: "measured-energy",
  })
  expect(
    classifyCaptureAvailability({
      frames: 3,
      signalFrames: 0,
      peakRms: 0,
      sampleSpanMs: 500,
    }),
  ).toEqual({
    availability: "measured-silence",
    availabilityReason: "zero-energy",
  })
  for (const partial of [
    { ...summary, frames: 2, signalFrames: 2 },
    { ...summary, sampleSpanMs: 499 },
    { ...summary, signalFrames: 2 },
    { ...summary, signalFrames: 0, peakRms: 0.00001 },
  ])
    expect(classifyCaptureAvailability(partial).availability).toBe(
      "inconclusive",
    )
})

test("unavailable witnesses or invalid app proofs never claim or start capture", async () => {
  for (const options of [
    { witnesses: 0 },
    { witnesses: 2 },
    { preflight: JSON.stringify({ ...preflight, scope: "process" }) },
  ]) {
    const setup = fixture(options)
    expect(
      (
        await Effect.runPromise(
          inspectApplicationCapture(setup.claim, setup.boundary),
        )
      ).status,
    ).toBe("unavailable")
    expect(setup.events).not.toContain("claim")
    expect(
      setup.calls.some((args) => args[0] === applicationCapture.nativeFlag),
    ).toBe(false)
  }
})

test("a failed one-shot claim prevents capture despite valid metadata", async () => {
  const setup = fixture()
  const result = await Effect.runPromise(
    inspectApplicationCapture(
      Effect.fail(helperError("unavailable")),
      setup.boundary,
    ),
  )
  expect(result.status).toBe("failed")
  expect(setup.calls).toHaveLength(2)
})

test("invalid summaries cannot turn missing stream, failed cleanup, or claimed isolation into success", async () => {
  for (const value of [
    { ...summary, streamStarted: false },
    { ...summary, cleanup: "failed" },
    { ...summary, isolationEstablished: true },
    { ...summary, verification: "failed" },
    { ...summary, matchingApplications: 2 },
    { ...summary, signalFrames: 11 },
    { ...summary, peakRms: 2 },
    { ...summary, sampleSpanMs: 15001 },
    { ...summary, frames: 0, signalFrames: 0, peakRms: 0, sampleSpanMs: 500 },
    { ...summary, signalFrames: 3, peakRms: 0 },
  ]) {
    const setup = fixture({ payload: JSON.stringify(value) })
    expect(
      (
        await Effect.runPromise(
          inspectApplicationCapture(setup.claim, setup.boundary),
        )
      ).status,
    ).toBe("failed")
  }
  const oversized = fixture({ payload: "x".repeat(4097) })
  expect(
    (
      await Effect.runPromise(
        inspectApplicationCapture(oversized.claim, oversized.boundary),
      )
    ).status,
  ).toBe("failed")
})

test("native cleanup failure supersedes denial and physical cleanup failure supersedes both", async () => {
  for (const [code, fault, expected] of [
    [77, undefined, "permission"],
    [77, "stdout", "permission"],
    [77, "heartbeat", "permission"],
    [70, undefined, "cleanup-failed"],
    [70, "stdout", "cleanup-failed"],
    [77, "cleanup", "cleanup-failed"],
  ] as const) {
    const setup = fixture({ code, ...(fault ? { fault } : {}) })
    const result = await Effect.runPromise(
      inspectApplicationCapture(setup.claim, setup.boundary),
    )
    expect(result.status).toBe("failed")
    if (result.status !== "failed")
      throw new Error("failed native capture became checked")
    expect(result.reason).toBe(expected)
  }
})

test("capture cancellation joins physical helper exit and emits no measurement", async () => {
  const setup = fixture({ pending: true })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* inspectApplicationCapture(
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
