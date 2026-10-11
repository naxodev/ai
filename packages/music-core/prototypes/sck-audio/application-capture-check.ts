/** Count-only feasibility. This result can never establish audio isolation. */
import { Effect, Schema } from "effect"
import { helperError } from "../../audio/helper-process.ts"
import { prepareApplicationArguments } from "./application-check.ts"
import { applicationCapture } from "./application-capture.ts"
import { makeBoundedProbeInspector } from "./bounded-probe-process.ts"

const FrameCount = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(300),
)
const CaptureSummary = Schema.Struct({
  event: Schema.Literal("sck-application-feasibility"),
  scope: Schema.Literal("kaset-application"),
  verification: Schema.Literal("passed-throughout"),
  streamStarted: Schema.Literal(true),
  cleanup: Schema.Literal("joined"),
  matchingApplications: Schema.Literal(1),
  frames: FrameCount,
  signalFrames: FrameCount,
  peakRms: Schema.Finite.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(1),
  ),
  sampleSpanMs: Schema.Finite.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(15000),
  ),
  isolationEstablished: Schema.Literal(false),
})
interface CaptureSummary extends Schema.Schema.Type<typeof CaptureSummary> {}

export const classifyCaptureAvailability = (
  summary: Pick<
    CaptureSummary,
    "frames" | "signalFrames" | "peakRms" | "sampleSpanMs"
  >,
) => {
  if (summary.frames < 3)
    return {
      availability: "inconclusive",
      availabilityReason: "insufficient-frames",
    } as const
  if (summary.sampleSpanMs < 500)
    return {
      availability: "inconclusive",
      availabilityReason: "insufficient-span",
    } as const
  if (
    summary.signalFrames >= 3 &&
    summary.peakRms >= applicationCapture.signalRmsThreshold
  )
    return {
      availability: "signal-observed",
      availabilityReason: "measured-energy",
    } as const
  return summary.peakRms === 0 && summary.signalFrames === 0
    ? ({
        availability: "measured-silence",
        availabilityReason: "zero-energy",
      } as const)
    : ({
        availability: "inconclusive",
        availabilityReason: "insufficient-signal",
      } as const)
}

export const inspectApplicationCapture = makeBoundedProbeInspector({
  helperPath: applicationCapture.helperPath,
  helperIdentifier: applicationCapture.helperIdentifier,
  metadataFlags: ["--list-kaset-sources", applicationCapture.preflightFlag],
  protectedFlag: applicationCapture.nativeFlag,
  operationTimeout: "20 seconds",
  prepare: prepareApplicationArguments(applicationCapture),
  decode: (value) =>
    Schema.decodeUnknownEffect(CaptureSummary)(value).pipe(
      Effect.mapError(() => helperError()),
      Effect.flatMap((decoded) => {
        if (
          decoded.signalFrames > decoded.frames ||
          (decoded.frames === 0 &&
            (decoded.sampleSpanMs !== 0 || decoded.peakRms !== 0)) ||
          (decoded.signalFrames > 0 &&
            decoded.peakRms < applicationCapture.signalRmsThreshold) ||
          (decoded.signalFrames === 0 &&
            decoded.peakRms >= applicationCapture.signalRmsThreshold) ||
          (decoded.frames === 1 && decoded.sampleSpanMs !== 0)
        )
          return Effect.fail(helperError())
        const summary: CaptureSummary = {
          event: decoded.event,
          scope: decoded.scope,
          verification: decoded.verification,
          streamStarted: decoded.streamStarted,
          cleanup: decoded.cleanup,
          matchingApplications: decoded.matchingApplications,
          frames: decoded.frames,
          signalFrames: decoded.signalFrames,
          peakRms: decoded.peakRms,
          sampleSpanMs: decoded.sampleSpanMs,
          isolationEstablished: decoded.isolationEstablished,
        }
        return Effect.succeed({
          ...summary,
          ...classifyCaptureAvailability(summary),
        })
      }),
    ),
})
