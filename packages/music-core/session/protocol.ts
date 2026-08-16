import { Effect } from "effect"
import * as Schema from "effect/Schema"
import { Buffer } from "node:buffer"
import type { PlayerState as CorePlayerState } from "../types.ts"
import { MAX_ARTWORK_BASE64_CHARS, PACKAGE_VERSION } from "./config.ts"

export { PACKAGE_VERSION }

export const LEGACY_PROTOCOL = { major: 1, minor: 0 } as const
export const PROTOCOL = { major: 1, minRevision: 0, maxRevision: 1 } as const
export const baselineCapabilities = [
  "state-replay",
  "transport",
  "native-artwork",
] as const

const SafeInt = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)
const ProtocolErrorCodeSchema = Schema.Literals([
  "INCOMPATIBLE_PROTOCOL",
  "INVALID_REQUEST",
  "DUPLICATE_REQUEST_ID",
  "UNSUPPORTED_CAPABILITY",
  "UNSUPPORTED_ACTION",
  "INVALID_SEEK",
  "PROVIDER_FAILURE",
  "SERVER_BUSY",
  "CONNECTION_LOST",
  "INDETERMINATE_COMMAND",
  "DISPOSED",
])

export const ProtocolRangeSchema = Schema.Struct({
  major: SafeInt,
  minRevision: SafeInt,
  maxRevision: SafeInt,
}).check(
  Schema.makeFilter((range) =>
    range.minRevision <= range.maxRevision
      ? []
      : [{ path: ["minRevision"], issue: "must not exceed maxRevision" }],
  ),
)
export type ProtocolRange = Schema.Schema.Type<typeof ProtocolRangeSchema>

export const LegacyProtocolSchema = Schema.Struct({
  major: Schema.Literal(LEGACY_PROTOCOL.major),
  minor: Schema.Literal(LEGACY_PROTOCOL.minor),
})
export type LegacyProtocol = Schema.Schema.Type<typeof LegacyProtocolSchema>

export const NegotiatedProtocolSchema = Schema.Struct({
  ...ProtocolRangeSchema.fields,
  selectedRevision: SafeInt,
}).check(
  Schema.makeFilter((protocol) =>
    protocol.selectedRevision >= protocol.minRevision &&
    protocol.selectedRevision <= protocol.maxRevision
      ? []
      : [
          {
            path: ["selectedRevision"],
            issue: "must lie within the negotiated revision range",
          },
        ],
  ),
)
export type NegotiatedProtocol = Schema.Schema.Type<
  typeof NegotiatedProtocolSchema
>

export const IncompatibilityDetailsSchema = Schema.Struct({
  client: ProtocolRangeSchema,
  daemon: ProtocolRangeSchema,
})
export type IncompatibilityDetails = Schema.Schema.Type<
  typeof IncompatibilityDetailsSchema
>

export const ProtocolErrorSchema = Schema.Struct({
  code: ProtocolErrorCodeSchema,
  message: Schema.String,
  retryable: Schema.Boolean,
  details: Schema.optionalKey(IncompatibilityDetailsSchema),
}).check(
  Schema.makeFilter((error) => {
    if (error.code === "INCOMPATIBLE_PROTOCOL")
      return error.details === undefined
        ? [
            {
              path: ["details"],
              issue: "is required for incompatible protocols",
            },
          ]
        : []
    return error.details === undefined
      ? []
      : [
          {
            path: ["details"],
            issue: "is only valid for incompatible protocols",
          },
        ]
  }),
)
export type ProtocolError = Schema.Schema.Type<typeof ProtocolErrorSchema>
export type ProtocolErrorCode = ProtocolError["code"]

export const CapabilitySchema = Schema.String
export type Capability = Schema.Schema.Type<typeof CapabilitySchema>
export const HostKindSchema = Schema.Literals(["opencode", "pi", "test"])
export type HostKind = Schema.Schema.Type<typeof HostKindSchema>
export const TransportActionSchema = Schema.Literals([
  "toggle",
  "play",
  "pause",
  "next",
  "previous",
  "seek",
])
export type TransportAction = Schema.Schema.Type<typeof TransportActionSchema>
export const TransportResultSchema = Schema.Struct({
  action: TransportActionSchema,
})
export type TransportResult = Schema.Schema.Type<typeof TransportResultSchema>

export const ProviderStatusSchema = Schema.Struct({
  kind: Schema.Literals(["ready", "degraded", "unavailable"]),
  provider: Schema.Union([
    Schema.Literals(["media-control", "nowplaying-cli"]),
    Schema.Null,
  ]),
  message: Schema.String,
})
export type ProviderStatus = Schema.Schema.Type<typeof ProviderStatusSchema>

const BoundedIdentityString = Schema.String.check(Schema.isMaxLength(1_024))
export const ArtworkIdentitySchema = Schema.Struct({
  id: BoundedIdentityString.check(Schema.isMinLength(1)),
  name: BoundedIdentityString,
  artists: BoundedIdentityString,
  album: BoundedIdentityString,
  duration_ms: SafeInt,
})
export type ArtworkIdentity = Schema.Schema.Type<typeof ArtworkIdentitySchema>
const CanonicalBase64 = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ARTWORK_BASE64_CHARS),
  Schema.makeFilter((value) => {
    // This guard is deliberately inside the filter: Schema accumulates other
    // check failures, so an earlier max-length failure alone cannot prevent a
    // later canonicality check from allocating an attacker-controlled buffer.
    if (value.length > MAX_ARTWORK_BASE64_CHARS || value.length % 4 !== 0)
      return [{ path: [], issue: "must be bounded canonical base64" }]
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value))
      return [{ path: [], issue: "must be canonical base64" }]
    return Buffer.from(value, "base64").toString("base64") === value
      ? []
      : [{ path: [], issue: "must be canonical base64" }]
  }),
)
export const ArtworkResultSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("available"),
    base64: CanonicalBase64,
  }),
  Schema.Struct({ type: Schema.Literal("unavailable") }),
  Schema.Struct({ type: Schema.Literal("stale") }),
  Schema.Struct({ type: Schema.Literal("too-large") }),
])
export type ArtworkResult = Schema.Schema.Type<typeof ArtworkResultSchema>
export const TrackSchema = Schema.Struct({
  uri: Schema.String,
  id: Schema.String,
  name: Schema.String,
  artists: Schema.String,
  album: Schema.String,
  duration_ms: SafeInt,
})
export const DeviceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  is_active: Schema.Boolean,
  volume_percent: Schema.Union([Schema.Finite, Schema.Null]),
  supports_volume: Schema.Boolean,
})
export const PlayerStateSchema = Schema.Struct({
  is_playing: Schema.Boolean,
  progress_ms: SafeInt,
  shuffle: Schema.Boolean,
  repeat: Schema.Literals(["off", "track", "context"]),
  device: Schema.Union([DeviceSchema, Schema.Null]),
  track: Schema.Union([TrackSchema, Schema.Null]),
  fetched_at: SafeInt,
})
export const RevisionedStateSchema = Schema.Struct({
  daemonInstanceId: Schema.String,
  revision: SafeInt,
  state: PlayerStateSchema,
})
export type RevisionedState = Schema.Schema.Type<typeof RevisionedStateSchema>

export const LegacyHelloRequestSchema = Schema.Struct({
  type: Schema.Literal("hello"),
  requestId: SafeInt,
  protocol: LegacyProtocolSchema,
  packageVersion: Schema.String,
  clientId: Schema.String,
  hostKind: HostKindSchema,
  capabilities: Schema.Array(CapabilitySchema),
})
export const CurrentHelloRequestSchema = Schema.Struct({
  type: Schema.Literal("hello"),
  requestId: SafeInt,
  protocol: ProtocolRangeSchema,
  packageVersion: Schema.String,
  clientId: Schema.String,
  hostKind: HostKindSchema,
  capabilities: Schema.Array(CapabilitySchema),
})
export const HelloRequestSchema = Schema.Union([
  LegacyHelloRequestSchema,
  CurrentHelloRequestSchema,
])
export type LegacyHelloRequest = Schema.Schema.Type<
  typeof LegacyHelloRequestSchema
>
export type CurrentHelloRequest = Schema.Schema.Type<
  typeof CurrentHelloRequestSchema
>
export type HelloRequest = LegacyHelloRequest | CurrentHelloRequest

export const StateRequestSchema = Schema.Struct({
  type: Schema.Literal("state"),
  requestId: SafeInt,
})
export type StateRequest = Schema.Schema.Type<typeof StateRequestSchema>
export const TransportRequestSchema = Schema.Struct({
  type: Schema.Literal("transport"),
  requestId: SafeInt,
  action: TransportActionSchema,
  positionMs: Schema.optionalKey(SafeInt),
}).check(
  Schema.makeFilter((request) => {
    if (request.action === "seek")
      return request.positionMs === undefined
        ? [{ path: ["positionMs"], issue: "is required for seek" }]
        : []
    return request.positionMs === undefined
      ? []
      : [{ path: ["positionMs"], issue: "is only valid for seek" }]
  }),
)
export type TransportRequest = Schema.Schema.Type<typeof TransportRequestSchema>
export const ArtworkRequestSchema = Schema.Struct({
  type: Schema.Literal("artwork"),
  requestId: SafeInt,
  identity: ArtworkIdentitySchema,
})
export type ArtworkRequest = Schema.Schema.Type<typeof ArtworkRequestSchema>
export type Request =
  HelloRequest | StateRequest | TransportRequest | ArtworkRequest

export const StatusEventSchema = Schema.Struct({
  type: Schema.Literal("status"),
  status: ProviderStatusSchema,
})
export const StateEventSchema = Schema.Struct({
  type: Schema.Literal("state"),
  snapshot: RevisionedStateSchema,
})
export type Event =
  | Schema.Schema.Type<typeof StatusEventSchema>
  | Schema.Schema.Type<typeof StateEventSchema>

export const LegacyHelloResultSchema = Schema.Struct({
  daemonInstanceId: Schema.String,
  packageVersion: Schema.String,
  protocol: LegacyProtocolSchema,
  capabilities: Schema.Array(CapabilitySchema),
})
export const HelloResultSchema = Schema.Struct({
  daemonInstanceId: Schema.String,
  packageVersion: Schema.String,
  protocol: NegotiatedProtocolSchema,
  capabilities: Schema.Array(CapabilitySchema),
})
export type HelloResult = Schema.Schema.Type<typeof HelloResultSchema>

export const SuccessResponseSchema = Schema.Struct({
  type: Schema.Literal("response"),
  requestId: SafeInt,
  ok: Schema.Literal(true),
  data: Schema.Unknown,
  // Known opposite payloads are forbidden while unrelated additive keys remain
  // tolerated by Struct's normal excess-property behavior.
  error: Schema.optionalKey(Schema.Never),
})
export const FailureResponseSchema = Schema.Struct({
  type: Schema.Literal("response"),
  requestId: SafeInt,
  ok: Schema.Literal(false),
  error: ProtocolErrorSchema,
  data: Schema.optionalKey(Schema.Never),
})
export const ResponseSchema = Schema.Union([
  SuccessResponseSchema,
  FailureResponseSchema,
])
export type Response = Schema.Schema.Type<typeof ResponseSchema>

const RequestEnvelopeSchema = Schema.Struct({
  type: Schema.String,
  requestId: SafeInt,
})
const TransportEnvelopeSchema = Schema.Struct({
  type: Schema.Literal("transport"),
  requestId: SafeInt,
  action: Schema.String,
  // The envelope preserves an invalid seek position long enough to map it to
  // the stable INVALID_SEEK error; the final request schema owns acceptance.
  positionMs: Schema.optionalKey(Schema.Unknown),
})
export const ServerFrameSchema = Schema.Union([
  StatusEventSchema,
  StateEventSchema,
  ResponseSchema,
])

const isSafeNonNegativeInteger = (value: number) =>
  Number.isSafeInteger(value) && value >= 0
const decode = <A>(
  schema: Schema.Codec<A, unknown, never>,
  value: unknown,
  message: string,
) => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    throw protocolError("INVALID_REQUEST", message)
  }
}
const validRange = (range: ProtocolRange) =>
  isSafeNonNegativeInteger(range.major) &&
  isSafeNonNegativeInteger(range.minRevision) &&
  isSafeNonNegativeInteger(range.maxRevision) &&
  range.minRevision <= range.maxRevision

export function protocolError(
  code: Exclude<ProtocolErrorCode, "INCOMPATIBLE_PROTOCOL">,
  message: string,
  retryable = false,
): ProtocolError {
  return { code, message, retryable }
}
export function protocolErrorFromUnknown(
  value: unknown,
): ProtocolError | undefined {
  try {
    return Schema.decodeUnknownSync(ProtocolErrorSchema)(value)
  } catch {
    return undefined
  }
}
export function incompatibility(
  client: ProtocolRange,
  daemon: ProtocolRange = PROTOCOL,
): ProtocolError {
  return {
    code: "INCOMPATIBLE_PROTOCOL",
    message: `protocol range ${client.major}.${client.minRevision}-${client.maxRevision} is incompatible with daemon range ${daemon.major}.${daemon.minRevision}-${daemon.maxRevision}`,
    retryable: false,
    details: { client, daemon },
  }
}

/** Extract only a schema-valid correlatable ID; never fabricate one. */
export function requestIdFromUnknown(value: unknown): number | undefined {
  try {
    const decoded = Schema.decodeUnknownSync(RequestEnvelopeSchema)(value)
    return isSafeNonNegativeInteger(decoded.requestId)
      ? decoded.requestId
      : undefined
  } catch {
    return undefined
  }
}

export type NegotiatedSession = {
  readonly protocol: NegotiatedProtocol
  readonly capabilities: string[]
  readonly legacy: boolean
}
const legacyRange = (): ProtocolRange => ({
  major: LEGACY_PROTOCOL.major,
  minRevision: LEGACY_PROTOCOL.minor,
  maxRevision: LEGACY_PROTOCOL.minor,
})
export function negotiateHello(
  hello: HelloRequest,
  daemon: ProtocolRange = PROTOCOL,
  daemonCapabilities: readonly string[] = baselineCapabilities,
): NegotiatedSession | ProtocolError {
  const offered = "minor" in hello.protocol ? legacyRange() : hello.protocol
  if (!validRange(offered) || !validRange(daemon))
    return protocolError("INVALID_REQUEST", "invalid protocol revision range")
  if (offered.major !== daemon.major) return incompatibility(offered, daemon)
  const minimum = Math.max(offered.minRevision, daemon.minRevision)
  const maximum = Math.min(offered.maxRevision, daemon.maxRevision)
  if (minimum > maximum) return incompatibility(offered, daemon)
  const capabilities = daemonCapabilities.filter((capability) =>
    hello.capabilities.includes(capability),
  )
  if (!capabilities.includes("state-replay"))
    return protocolError(
      "UNSUPPORTED_CAPABILITY",
      "state-replay capability is required",
    )
  return {
    protocol: {
      major: daemon.major,
      minRevision: daemon.minRevision,
      maxRevision: daemon.maxRevision,
      selectedRevision: maximum,
    },
    capabilities,
    legacy: "minor" in hello.protocol,
  }
}

export function decodeRequest(value: unknown): Request {
  const envelope = decode(
    RequestEnvelopeSchema,
    value,
    "request must have a non-negative safe requestId",
  )
  if (!isSafeNonNegativeInteger(envelope.requestId))
    throw protocolError(
      "INVALID_REQUEST",
      "request must have a non-negative safe requestId",
    )
  if (envelope.type === "hello") {
    const hello = decode(HelloRequestSchema, value, "invalid hello request")
    if (
      ("minor" in hello.protocol &&
        (!isSafeNonNegativeInteger(hello.protocol.major) ||
          !isSafeNonNegativeInteger(hello.protocol.minor))) ||
      (!("minor" in hello.protocol) && !validRange(hello.protocol))
    )
      throw protocolError("INVALID_REQUEST", "invalid hello request")
    return hello
  }
  if (envelope.type === "state")
    return decode(StateRequestSchema, value, "invalid state request")
  if (envelope.type === "artwork")
    return decode(ArtworkRequestSchema, value, "invalid artwork request")
  if (envelope.type === "transport") {
    const raw = decode(
      TransportEnvelopeSchema,
      value,
      "invalid transport request",
    )
    if (
      !(
        [
          "toggle",
          "play",
          "pause",
          "next",
          "previous",
          "seek",
        ] as readonly string[]
      ).includes(raw.action)
    )
      throw protocolError("UNSUPPORTED_ACTION", "unknown transport action")
    if (raw.action === "seek") {
      if (
        typeof raw.positionMs !== "number" ||
        !isSafeNonNegativeInteger(raw.positionMs)
      )
        throw protocolError(
          "INVALID_SEEK",
          "seek position must be a non-negative safe integer",
        )
    } else if ("positionMs" in raw)
      throw protocolError("INVALID_REQUEST", "only seek accepts positionMs")
    return decode(TransportRequestSchema, raw, "invalid transport request")
  }
  throw protocolError("INVALID_REQUEST", "unknown request type")
}

/** Shared Effect decoder for the server's Effect request boundary. */
export const decodeRequestEffect = (value: unknown) =>
  Effect.try({
    try: () => decodeRequest(value),
    catch: (cause) =>
      protocolErrorFromUnknown(cause) ??
      protocolError("INVALID_REQUEST", "invalid request"),
  })

export function decodeTransportResult(value: unknown): TransportResult {
  return decode(TransportResultSchema, value, "invalid transport result")
}
export function decodeArtworkIdentity(value: unknown): ArtworkIdentity {
  return decode(ArtworkIdentitySchema, value, "invalid artwork identity")
}
export function decodeArtworkResult(value: unknown): ArtworkResult {
  return decode(ArtworkResultSchema, value, "invalid artwork result")
}

export function decodeServerFrame(value: unknown): Event | Response {
  const frame = decode(ServerFrameSchema, value, "invalid server frame")
  if (frame.type === "response" && !isSafeNonNegativeInteger(frame.requestId))
    throw protocolError("INVALID_REQUEST", "invalid response")
  if (frame.type === "state") {
    if (
      !isSafeNonNegativeInteger(frame.snapshot.revision) ||
      !isSafeNonNegativeInteger(frame.snapshot.state.progress_ms) ||
      !isSafeNonNegativeInteger(frame.snapshot.state.fetched_at) ||
      (frame.snapshot.state.track !== null &&
        !isSafeNonNegativeInteger(frame.snapshot.state.track.duration_ms))
    )
      throw protocolError("INVALID_REQUEST", "invalid state event")
  }
  return frame
}

export function decodeHelloResult(value: unknown): HelloResult {
  const result = decode(HelloResultSchema, value, "invalid hello result")
  const { protocol } = result
  if (
    !validRange(protocol) ||
    !isSafeNonNegativeInteger(protocol.selectedRevision) ||
    protocol.selectedRevision < protocol.minRevision ||
    protocol.selectedRevision > protocol.maxRevision
  )
    throw protocolError("INVALID_REQUEST", "invalid hello result")
  return result
}

export function response(requestId: number, data: unknown): Response {
  return { type: "response", requestId, ok: true, data }
}
export function failure(requestId: number, error: ProtocolError): Response {
  return { type: "response", requestId, ok: false, error }
}
export function helloResult(
  daemonInstanceId: string,
  negotiated: NegotiatedSession,
): HelloResult | Schema.Schema.Type<typeof LegacyHelloResultSchema> {
  if (negotiated.legacy)
    return {
      daemonInstanceId,
      packageVersion: PACKAGE_VERSION,
      protocol: LEGACY_PROTOCOL,
      capabilities: negotiated.capabilities,
    }
  return {
    daemonInstanceId,
    packageVersion: PACKAGE_VERSION,
    protocol: negotiated.protocol,
    capabilities: negotiated.capabilities,
  }
}

type _PlayerStateCompatibility =
  RevisionedState["state"] extends CorePlayerState ? true : never
export const playerStateCompatibility: _PlayerStateCompatibility = true
