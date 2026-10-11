/** Separate Safari positive control. A pass is limited to the paused-Kaset case. */
import { Effect, Schema } from "effect"
import {
  helperError,
  type NativeHelperDependencies,
} from "../../audio/helper-process.ts"
import { prepareApplicationArguments } from "./application-check.ts"
import {
  makeBoundedProbeInspector,
  type ReadProbeJson,
} from "./bounded-probe-process.ts"
import { safariExclusion } from "./safari-exclusion.ts"

const Count = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(60),
)
const Power = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1),
)
const ExclusionSummary = Schema.Struct({
  event: Schema.Literal("sck-safari-exclusion"),
  scope: Schema.Literal("kaset-paused-safari-marker"),
  verification: Schema.Literal("passed-throughout"),
  streamsStarted: Schema.Literal(2),
  cleanup: Schema.Literal("joined"),
  windows: Count,
  referenceWindows: Count,
  violations: Count,
  clippedWindows: Count,
  targetTotalMax: Power,
  targetMarkerMax: Power,
  referenceTotalMax: Power,
  referenceMarkerMin: Power,
  referenceMarkerMax: Power,
  isolationEstablished: Schema.Literal(false),
})
interface ExclusionSummary extends Schema.Schema.Type<
  typeof ExclusionSummary
> {}
const SafariPreflight = Schema.Struct({
  event: Schema.Literal("sck-safari-preflight"),
  scope: Schema.Literal("safari-application"),
  identity: Schema.Struct({
    processIdentifier: Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(2147483647),
    ),
    launchIdentity: Schema.String.check(
      Schema.isPattern(/^\d+:\d+$/),
      Schema.isMaxLength(512),
    ),
    executableIdentity: Schema.String.check(
      Schema.isPattern(
        /^\/System\/Volumes\/Preboot\/Cryptexes\/App\/System\/Applications\/Safari\.app\/Contents\/MacOS\/Safari\|[0-9a-f]{40}$/,
      ),
    ),
  }),
})

const prepare = Effect.fn("SafariExclusion.prepare")(function* (
  boundary: NativeHelperDependencies,
  readJson: ReadProbeJson,
) {
  const kaset = yield* prepareApplicationArguments({
    ...safariExclusion,
    preflightFlag: "--check-kaset-application",
  })(boundary, readJson)
  if (!kaset) return undefined
  const safari = yield* readJson([
    safariExclusion.preflightFlag,
    ...kaset,
  ]).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(SafariPreflight)(value).pipe(
        Effect.mapError(() => helperError()),
      ),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (!safari) return undefined
  return [
    ...kaset,
    "--application-id",
    String(safari.identity.processIdentifier),
    "--application-launch",
    safari.identity.launchIdentity,
    "--application-executable",
    safari.identity.executableIdentity,
  ]
})

export const inspectSafariExclusion = makeBoundedProbeInspector({
  helperPath: safariExclusion.helperPath,
  helperIdentifier: safariExclusion.helperIdentifier,
  metadataFlags: [
    "--list-kaset-sources",
    "--check-kaset-application",
    safariExclusion.preflightFlag,
  ],
  protectedFlag: safariExclusion.nativeFlag,
  operationTimeout: "20 seconds",
  prepare,
  decode: (value) =>
    Schema.decodeUnknownEffect(ExclusionSummary)(value).pipe(
      Effect.mapError(() => helperError()),
      Effect.flatMap((decoded) => {
        if (
          decoded.referenceWindows > decoded.windows ||
          decoded.violations > decoded.referenceWindows ||
          decoded.violations + decoded.clippedWindows > decoded.windows ||
          decoded.clippedWindows > decoded.windows ||
          decoded.referenceMarkerMin > decoded.referenceMarkerMax ||
          (decoded.windows === 0 &&
            [
              decoded.targetTotalMax,
              decoded.targetMarkerMax,
              decoded.referenceTotalMax,
              decoded.referenceMarkerMin,
              decoded.referenceMarkerMax,
            ].some((value) => value !== 0)) ||
          (decoded.referenceWindows > 0 && decoded.referenceTotalMax === 0) ||
          (decoded.windows > 0 &&
            decoded.referenceWindows === decoded.windows &&
            decoded.referenceMarkerMin < 1e-4) ||
          (decoded.referenceWindows === decoded.windows &&
            decoded.clippedWindows === 0 &&
            decoded.violations === 0 &&
            (decoded.targetTotalMax >
              Math.max(1e-10, 1e-4 * decoded.referenceTotalMax) ||
              decoded.targetMarkerMax >
                Math.max(1e-8, 1e-4 * decoded.referenceMarkerMax))) ||
          (decoded.violations > 0 &&
            decoded.targetTotalMax <= 1e-10 &&
            decoded.targetMarkerMax <= 1e-8)
        )
          return Effect.fail(helperError())
        const summary: ExclusionSummary = {
          event: decoded.event,
          scope: decoded.scope,
          verification: decoded.verification,
          streamsStarted: decoded.streamsStarted,
          cleanup: decoded.cleanup,
          windows: decoded.windows,
          referenceWindows: decoded.referenceWindows,
          violations: decoded.violations,
          clippedWindows: decoded.clippedWindows,
          targetTotalMax: decoded.targetTotalMax,
          targetMarkerMax: decoded.targetMarkerMax,
          referenceTotalMax: decoded.referenceTotalMax,
          referenceMarkerMin: decoded.referenceMarkerMin,
          referenceMarkerMax: decoded.referenceMarkerMax,
          isolationEstablished: decoded.isolationEstablished,
        }
        const result =
          decoded.windows !== 60
            ? ({
                verdict: "inconclusive",
                reason: "incomplete-coverage",
              } as const)
            : decoded.clippedWindows > 0
              ? ({
                  verdict: "inconclusive",
                  reason: "clipped-samples",
                } as const)
              : decoded.referenceWindows !== 60
                ? ({
                    verdict: "inconclusive",
                    reason: "invalid-reference",
                  } as const)
                : decoded.violations > 0
                  ? ({
                      verdict: "failed",
                      reason: "target-energy-limit",
                    } as const)
                  : ({
                      verdict: "passed",
                      reason: "paused-target-exclusion",
                    } as const)
        return Effect.succeed({ ...summary, ...result })
      }),
    ),
})
