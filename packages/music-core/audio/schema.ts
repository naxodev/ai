import { Schema } from "effect"
import { Buffer } from "node:buffer"

/**
 * Host-neutral audio visualization contracts.
 *
 * Production capture is unavailable. These types describe an opt-in daemon
 * boundary. They do not start a tap, grant consent, or analyze microphone or
 * system-mix audio. Callers must pass `audioVisualizationCapability` explicitly.
 * `baselineCapabilities` does not include it.
 */

export const audioVisualizationCapability = "audio-visualization-v1" as const
export const audioInterestLeaseCapability = "audio-interest-lease-v1" as const
export const audioVisualizationCapabilities = [
  audioVisualizationCapability,
  audioInterestLeaseCapability,
] as const
export const AUDIO_PROTOCOL_REVISION = 2 as const

export const MAX_AUDIO_SOURCES = 32
export const MAX_SPECTRUM_BANDS = 64
export const MAX_ENVELOPE_BUCKETS = 128
export const MAX_AUDIO_FEATURE_FRAME_BYTES = 16 * 1024
export const MAX_AUDIO_FEATURE_HZ = 20
export const AUDIO_SAMPLE_AGE_EXPIRY_MS = 500
export const AUDIO_SELECTION_TOKEN_TTL_MS = 15_000
export const AUDIO_INTEREST_LEASE_MS = 5_000
export const AUDIO_INTEREST_RENEW_MS = 1_000
export const AUDIO_STARTUP_INTEREST_MS = 30_000
export const AUDIO_INTEREST_SWEEP_MS = 250
export const AUDIO_PENDING_TASK_LIMIT = 2
export const MAX_AUDIO_SELECTIONS_PER_CONNECTION = 8
export const AUDIO_FEATURE_INTERVAL_MS = 1_000 / MAX_AUDIO_FEATURE_HZ
export const AUDIO_CLOCK_DOMAIN = "capture-monotonic" as const

const SafeInt = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)
const PositiveSafeInt = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const FiniteNonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const OpaqueIdentity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
)
const BoundedLabel = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
)
const SelectionTokenSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
)

export const AudioFeatureCapabilities = Schema.Struct({
  spectrum: Schema.Literals(["measured", "absent"]),
  envelope: Schema.Literals(["measured", "absent"]),
  channels: Schema.Literals(["absent", "mono", "stereo"]),
})
export interface AudioFeatureCapabilities extends Schema.Schema.Type<
  typeof AudioFeatureCapabilities
> {}

export const NativeCaptureIdentity = Schema.Struct({
  kind: Schema.Literal("native"),
  processIdentifier: PositiveSafeInt,
  launchIdentity: OpaqueIdentity,
  executableIdentity: OpaqueIdentity,
  coreAudioObject: OpaqueIdentity,
})
export interface NativeCaptureIdentity extends Schema.Schema.Type<
  typeof NativeCaptureIdentity
> {}

export const CooperativeCaptureIdentity = Schema.Struct({
  kind: Schema.Literal("cooperative"),
  cooperativeIdentity: OpaqueIdentity,
})
export interface CooperativeCaptureIdentity extends Schema.Schema.Type<
  typeof CooperativeCaptureIdentity
> {}

export const CaptureIdentity = Schema.Union([
  NativeCaptureIdentity,
  CooperativeCaptureIdentity,
])
export type CaptureIdentity = Schema.Schema.Type<typeof CaptureIdentity>

export const sameCaptureIdentity = (
  left: CaptureIdentity,
  right: CaptureIdentity,
): boolean => {
  if (left.kind !== right.kind) return false
  if (left.kind === "native" && right.kind === "native")
    return (
      left.processIdentifier === right.processIdentifier &&
      left.launchIdentity === right.launchIdentity &&
      left.executableIdentity === right.executableIdentity &&
      left.coreAudioObject === right.coreAudioObject
    )
  if (left.kind === "cooperative" && right.kind === "cooperative")
    return left.cooperativeIdentity === right.cooperativeIdentity
  return false
}

export const isPidReuse = (
  previous: CaptureIdentity,
  next: CaptureIdentity,
): boolean =>
  previous.kind === "native" &&
  next.kind === "native" &&
  previous.processIdentifier === next.processIdentifier &&
  !sameCaptureIdentity(previous, next)

export const ResolvedCaptureSource = Schema.Struct({
  mode: Schema.Literals(["process", "now-playing", "cooperative"]),
  identity: CaptureIdentity,
  observationSequence: SafeInt,
  capabilities: AudioFeatureCapabilities,
  label: BoundedLabel,
  /** Internal local-only attribution; never a client-provided capture authority. */
  attribution: Schema.optionalKey(Schema.Literal("kaset-cache-v1")),
})
export interface ResolvedCaptureSource extends Schema.Schema.Type<
  typeof ResolvedCaptureSource
> {}

export const selectionMatchesIdentity = (
  source: ResolvedCaptureSource,
): boolean =>
  source.mode === "cooperative"
    ? source.identity.kind === "cooperative"
    : source.identity.kind === "native"

export const AudioSourceListEntry = Schema.Struct({
  label: BoundedLabel,
  mode: ResolvedCaptureSource.fields.mode,
  token: SelectionTokenSchema,
  capabilities: AudioFeatureCapabilities,
})
export interface AudioSourceListEntry extends Schema.Schema.Type<
  typeof AudioSourceListEntry
> {}

export const AudioSourceList = Schema.Struct({
  availability: Schema.Literals(["available", "unavailable"]),
  reason: Schema.optionalKey(
    Schema.Literals([
      "capture-adapter-unavailable",
      "not-negotiated",
      "unsupported",
    ]),
  ),
  sources: Schema.Array(AudioSourceListEntry).check(
    Schema.isMaxLength(MAX_AUDIO_SOURCES),
  ),
})
export interface AudioSourceList extends Schema.Schema.Type<
  typeof AudioSourceList
> {}

export const AudioStartResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("started"),
    generation: PositiveSafeInt,
    source: CaptureIdentity,
  }),
  Schema.Struct({
    type: Schema.Literal("joined"),
    generation: PositiveSafeInt,
    source: CaptureIdentity,
  }),
  Schema.Struct({ type: Schema.Literal("busy") }),
  Schema.Struct({
    type: Schema.Literal("unavailable"),
    reason: Schema.Literal("capture-adapter-unavailable"),
  }),
  Schema.Struct({
    type: Schema.Literal("rejected"),
    reason: Schema.Literals([
      "stale-identity",
      "pid-reuse",
      "expired-token",
      "unknown-token",
      "wrong-connection",
      "wrong-daemon",
      "unresolved-source",
      "canceled",
      "invalid-selection",
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    reason: Schema.Literals(["setup", "timeout", "permission"]),
  }),
])
export type AudioStartResult = Schema.Schema.Type<typeof AudioStartResult>

export const AudioStopResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("stopped"),
    generation: PositiveSafeInt,
    reason: Schema.Literals(["stop", "last-connection", "source-loss"]),
  }),
  Schema.Struct({
    type: Schema.Literal("rejected"),
    reason: Schema.Literal("not-joined"),
  }),
])
export type AudioStopResult = Schema.Schema.Type<typeof AudioStopResult>

export const AudioRenewResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("renewed"),
    generation: PositiveSafeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("rejected"),
    reason: Schema.Literal("not-joined"),
  }),
])
export type AudioRenewResult = Schema.Schema.Type<typeof AudioRenewResult>

export const AudioCaptureStatus = Schema.Union([
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({
    type: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "capture-adapter-unavailable",
      "not-negotiated",
      "unsupported",
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("acquiring"),
    generation: PositiveSafeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("active"),
    generation: PositiveSafeInt,
    source: CaptureIdentity,
    capabilities: AudioFeatureCapabilities,
  }),
  Schema.Struct({
    type: Schema.Literal("stopped"),
    generation: PositiveSafeInt,
    reason: Schema.Literals([
      "stop",
      "last-connection",
      "source-loss",
      "shutdown",
      "canceled",
      "lease-expired",
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    generation: PositiveSafeInt,
    reason: Schema.Literals([
      "setup",
      "timeout",
      "permission",
      "unsupported-features",
      "source-loss",
    ]),
  }),
])
export type AudioCaptureStatus = Schema.Schema.Type<typeof AudioCaptureStatus>

const EnvelopeBucket = Schema.Struct({
  min: Schema.Finite,
  max: Schema.Finite,
}).check(
  Schema.makeFilter((bucket) =>
    bucket.min <= bucket.max
      ? []
      : [{ path: ["min"], issue: "must not exceed max" }],
  ),
)

export const AudioFeatureFrame = Schema.Struct({
  daemonInstanceId: OpaqueIdentity,
  generation: PositiveSafeInt,
  sequence: PositiveSafeInt,
  timestampMs: FiniteNonNegative,
  publishedAtMs: FiniteNonNegative,
  clockDomain: Schema.Literal(AUDIO_CLOCK_DOMAIN),
  sampleAgeMs: FiniteNonNegative,
  source: CaptureIdentity,
  capabilities: AudioFeatureCapabilities,
  spectrum: Schema.Array(FiniteNonNegative).check(
    Schema.isMaxLength(MAX_SPECTRUM_BANDS),
  ),
  envelope: Schema.optionalKey(
    Schema.Array(EnvelopeBucket).check(
      Schema.isMaxLength(MAX_ENVELOPE_BUCKETS),
    ),
  ),
  channels: Schema.optionalKey(
    Schema.Struct({
      layout: Schema.Literals(["mono", "stereo"]),
      rms: Schema.Array(FiniteNonNegative).check(Schema.isMaxLength(2)),
      peaks: Schema.Array(FiniteNonNegative).check(Schema.isMaxLength(2)),
    }),
  ),
}).check(
  Schema.makeFilter((frame) => {
    const issues: Array<{ path: PropertyKey[]; issue: string }> = []
    if (frame.capabilities.spectrum === "absent") {
      if (frame.spectrum.length !== 0)
        issues.push({
          path: ["spectrum"],
          issue: "absent spectrum must not masquerade as silence",
        })
    } else if (frame.spectrum.length === 0)
      issues.push({
        path: ["spectrum"],
        issue: "measured spectrum must contain bands",
      })
    if (frame.capabilities.envelope === "absent") {
      if (frame.envelope !== undefined)
        issues.push({
          path: ["envelope"],
          issue: "absent envelope must be omitted",
        })
    } else if (frame.envelope === undefined || frame.envelope.length === 0)
      issues.push({
        path: ["envelope"],
        issue: "measured envelope must be present",
      })
    const expected =
      frame.capabilities.channels === "mono"
        ? 1
        : frame.capabilities.channels === "stereo"
          ? 2
          : 0
    if (expected === 0) {
      if (frame.channels !== undefined)
        issues.push({
          path: ["channels"],
          issue: "absent channels must be omitted",
        })
    } else if (
      frame.channels === undefined ||
      frame.channels.layout !== frame.capabilities.channels ||
      frame.channels.rms.length !== expected ||
      frame.channels.peaks.length !== expected
    )
      issues.push({
        path: ["channels"],
        issue: "channel layout must match measured capability",
      })
    if (
      Buffer.byteLength(JSON.stringify(frame), "utf8") >
      MAX_AUDIO_FEATURE_FRAME_BYTES
    )
      issues.push({
        path: [],
        issue: "encoded feature frame exceeds 16 KiB",
      })
    return issues
  }),
)
export interface AudioFeatureFrame extends Schema.Schema.Type<
  typeof AudioFeatureFrame
> {}

export const AudioFeatureDraft = Schema.Struct({
  timestampMs: FiniteNonNegative,
  sampleAgeMs: FiniteNonNegative,
  clockDomain: Schema.Literal(AUDIO_CLOCK_DOMAIN),
  spectrum: Schema.Array(FiniteNonNegative).check(
    Schema.isMaxLength(MAX_SPECTRUM_BANDS),
  ),
  envelope: Schema.optionalKey(
    Schema.Array(EnvelopeBucket).check(
      Schema.isMaxLength(MAX_ENVELOPE_BUCKETS),
    ),
  ),
  channels: Schema.optionalKey(
    Schema.Struct({
      layout: Schema.Literals(["mono", "stereo"]),
      rms: Schema.Array(FiniteNonNegative).check(Schema.isMaxLength(2)),
      peaks: Schema.Array(FiniteNonNegative).check(Schema.isMaxLength(2)),
    }),
  ),
})
export interface AudioFeatureDraft extends Schema.Schema.Type<
  typeof AudioFeatureDraft
> {}

export const decodeAudioFeatureFrame = (value: unknown) =>
  Schema.decodeUnknownResult(AudioFeatureFrame)(value)

export const audioFeatureFrameBytes = (frame: AudioFeatureFrame): number =>
  Buffer.byteLength(JSON.stringify(frame), "utf8")

/**
 * `nowMs` must be the capture-monotonic clock, not local socket receipt time.
 * Age is the sample age plus how long the frame has waited since publication,
 * so a frame buffered in a writer queue cannot become fresh on receipt.
 * A timestamp ahead of that clock is impossible and stale.
 */
export const audioFeatureFreshness = (input: {
  readonly frame: AudioFeatureFrame
  readonly nowMs: number
}): "fresh" | "stale" => {
  if (!Number.isFinite(input.nowMs)) return "stale"
  if (input.nowMs < input.frame.timestampMs) return "stale"
  if (input.nowMs < input.frame.publishedAtMs) return "stale"
  const sampleAge = Math.max(
    input.frame.sampleAgeMs + (input.nowMs - input.frame.publishedAtMs),
    input.nowMs - input.frame.timestampMs,
  )
  if (sampleAge >= AUDIO_SAMPLE_AGE_EXPIRY_MS) return "stale"
  return "fresh"
}

export const unavailableAudioSourceList = (
  reason:
    | "capture-adapter-unavailable"
    | "not-negotiated"
    | "unsupported" = "capture-adapter-unavailable",
): AudioSourceList => ({
  availability: "unavailable",
  reason,
  sources: [],
})

export const audioResultFromUnknown = <A>(
  schema: Schema.Decoder<A>,
  value: unknown,
) => Schema.decodeUnknownResult(schema)(value)
