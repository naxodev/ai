import * as Schema from "effect/Schema"
import type { PlayerState as CorePlayerState } from "../types.ts"
import { PACKAGE_VERSION } from "./config.ts"

export const PROTOCOL = { major: 1, minor: 0 } as const
export { PACKAGE_VERSION }
export const baselineCapabilities = ["state-replay", "transport"] as const
export type Capability = (typeof baselineCapabilities)[number]
export type HostKind = "opencode" | "pi" | "test"
export type TransportAction =
  "toggle" | "play" | "pause" | "next" | "previous" | "seek"
export type ProtocolErrorCode =
  | "INCOMPATIBLE_PROTOCOL"
  | "INVALID_REQUEST"
  | "DUPLICATE_REQUEST_ID"
  | "UNSUPPORTED_CAPABILITY"
  | "UNSUPPORTED_ACTION"
  | "INVALID_SEEK"
  | "PROVIDER_FAILURE"
  | "SERVER_BUSY"
  | "CONNECTION_LOST"
  | "INDETERMINATE_COMMAND"
  | "DISPOSED"
export type ProtocolError = {
  code: ProtocolErrorCode
  message: string
  retryable: boolean
}
export type ProviderStatus = {
  kind: "ready" | "degraded" | "unavailable"
  provider: "media-control" | "nowplaying-cli" | null
  message: string
}
export type RevisionedState = {
  daemonInstanceId: string
  revision: number
  state: CorePlayerState
}
export type HelloRequest = {
  type: "hello"
  requestId: number
  protocol: { major: number; minor: number }
  packageVersion: string
  clientId: string
  hostKind: HostKind
  capabilities: string[]
}
export type StateRequest = { type: "state"; requestId: number }
export type TransportRequest = {
  type: "transport"
  requestId: number
  action: TransportAction
  positionMs?: number
}
export type Request = HelloRequest | StateRequest | TransportRequest
export type Event =
  | { type: "status"; status: ProviderStatus }
  | { type: "state"; snapshot: RevisionedState }
export type Response =
  | { type: "response"; requestId: number; ok: true; data: unknown }
  | { type: "response"; requestId: number; ok: false; error: ProtocolError }
export type HelloResult = {
  daemonInstanceId: string
  packageVersion: string
  protocol: { major: number; minor: number }
  capabilities: string[]
}

// Public schemas make the wire model discoverable to Effect users. Parsers below
// additionally enforce semantic constraints and tolerate additive object fields.
const SafeInt = Schema.Finite.check(Schema.isInt())
export const ProtocolVersion = Schema.Struct({ major: SafeInt, minor: SafeInt })
export const ProviderStatusSchema = Schema.Struct({
  kind: Schema.Literals(["ready", "degraded", "unavailable"]),
  provider: Schema.Union([
    Schema.Literals(["media-control", "nowplaying-cli"]),
    Schema.Null,
  ]),
  message: Schema.String,
})
export const ErrorSchema = Schema.Struct({
  code: Schema.Literals([
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
  ]),
  message: Schema.String,
  retryable: Schema.Boolean,
})
export const HelloRequestSchema = Schema.Struct({
  type: Schema.Literal("hello"),
  requestId: SafeInt,
  protocol: ProtocolVersion,
  packageVersion: Schema.String,
  clientId: Schema.String,
  hostKind: Schema.Literals(["opencode", "pi", "test"]),
  capabilities: Schema.Array(Schema.String),
})
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
export const StateRequestSchema = Schema.Struct({
  type: Schema.Literal("state"),
  requestId: SafeInt,
})
export const TransportRequestSchema = Schema.Struct({
  type: Schema.Literal("transport"),
  requestId: SafeInt,
  action: Schema.Literals([
    "toggle",
    "play",
    "pause",
    "next",
    "previous",
    "seek",
  ]),
  positionMs: Schema.optionalKey(SafeInt),
})
export const StatusEventSchema = Schema.Struct({
  type: Schema.Literal("status"),
  status: ProviderStatusSchema,
})
export const StateEventSchema = Schema.Struct({
  type: Schema.Literal("state"),
  snapshot: RevisionedStateSchema,
})
export const HelloResultSchema = Schema.Struct({
  daemonInstanceId: Schema.String,
  packageVersion: Schema.String,
  protocol: ProtocolVersion,
  capabilities: Schema.Array(Schema.String),
})
export const ResponseSchema = Schema.Struct({
  type: Schema.Literal("response"),
  requestId: SafeInt,
  ok: Schema.Boolean,
  data: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(ErrorSchema),
})

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
function id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
/** Extract only a safely correlatable ID; never fabricate one for bad frames. */
export function requestIdFromUnknown(value: unknown): number | undefined {
  const candidate = record(value)?.requestId
  return id(candidate) ? candidate : undefined
}
function player(value: unknown): CorePlayerState | null {
  const state = record(value)
  if (
    !state ||
    typeof state.is_playing !== "boolean" ||
    !id(state.progress_ms) ||
    typeof state.shuffle !== "boolean" ||
    !(
      state.repeat === "off" ||
      state.repeat === "track" ||
      state.repeat === "context"
    ) ||
    !id(state.fetched_at)
  )
    return null
  if (!("track" in state) || !("device" in state)) return null
  const trackValue = state.track === null ? null : record(state.track)
  if (
    state.track !== null &&
    (!trackValue ||
      typeof trackValue.uri !== "string" ||
      typeof trackValue.id !== "string" ||
      typeof trackValue.name !== "string" ||
      typeof trackValue.artists !== "string" ||
      typeof trackValue.album !== "string" ||
      !id(trackValue.duration_ms))
  )
    return null
  const deviceValue = state.device === null ? null : record(state.device)
  if (
    state.device !== null &&
    (!deviceValue ||
      typeof deviceValue.id !== "string" ||
      typeof deviceValue.name !== "string" ||
      typeof deviceValue.type !== "string" ||
      typeof deviceValue.is_active !== "boolean" ||
      !(
        deviceValue.volume_percent === null ||
        (typeof deviceValue.volume_percent === "number" &&
          Number.isFinite(deviceValue.volume_percent))
      ) ||
      typeof deviceValue.supports_volume !== "boolean")
  )
    return null
  const track =
    trackValue === null
      ? null
      : (() => {
          const {
            uri,
            id: trackId,
            name,
            artists,
            album,
            duration_ms,
          } = trackValue
          if (
            typeof uri !== "string" ||
            typeof trackId !== "string" ||
            typeof name !== "string" ||
            typeof artists !== "string" ||
            typeof album !== "string" ||
            !id(duration_ms)
          )
            return null
          return { uri, id: trackId, name, artists, album, duration_ms }
        })()
  const device =
    deviceValue === null
      ? null
      : (() => {
          const {
            id: deviceId,
            name,
            type,
            is_active,
            volume_percent,
            supports_volume,
          } = deviceValue
          if (
            typeof deviceId !== "string" ||
            typeof name !== "string" ||
            typeof type !== "string" ||
            typeof is_active !== "boolean" ||
            !(
              volume_percent === null ||
              (typeof volume_percent === "number" &&
                Number.isFinite(volume_percent))
            ) ||
            typeof supports_volume !== "boolean"
          )
            return null
          return {
            id: deviceId,
            name,
            type,
            is_active,
            volume_percent,
            supports_volume,
          }
        })()
  if (
    (trackValue !== null && track === null) ||
    (deviceValue !== null && device === null)
  )
    return null
  return {
    is_playing: state.is_playing,
    progress_ms: state.progress_ms,
    shuffle: state.shuffle,
    repeat: state.repeat,
    track,
    device,
    fetched_at: state.fetched_at,
  }
}
function error(
  code: ProtocolErrorCode,
  message: string,
  retryable = false,
): ProtocolError {
  return { code, message, retryable }
}
export { error as protocolError }
export function decodeRequest(value: unknown): Request {
  const v = record(value)
  if (!v || typeof v.type !== "string" || !id(v.requestId))
    throw error(
      "INVALID_REQUEST",
      "request must have a non-negative safe requestId",
    )
  if (v.type === "hello") {
    let decoded: Omit<HelloRequest, "capabilities"> & {
      capabilities: readonly string[]
    }
    try {
      decoded = Schema.decodeUnknownSync(HelloRequestSchema)(v)
    } catch {
      throw error("INVALID_REQUEST", "invalid hello request")
    }
    if (decoded.requestId < 0)
      throw error("INVALID_REQUEST", "invalid hello request")
    return {
      type: "hello",
      requestId: decoded.requestId,
      protocol: {
        major: decoded.protocol.major,
        minor: decoded.protocol.minor,
      },
      packageVersion: decoded.packageVersion,
      clientId: decoded.clientId,
      hostKind: decoded.hostKind,
      capabilities: [...decoded.capabilities],
    }
  }
  if (v.type === "state") {
    let decoded: StateRequest
    try {
      decoded = Schema.decodeUnknownSync(StateRequestSchema)(v)
    } catch {
      throw error("INVALID_REQUEST", "invalid state request")
    }
    return { type: "state", requestId: decoded.requestId }
  }
  if (v.type === "transport") {
    if (
      !["toggle", "play", "pause", "next", "previous", "seek"].includes(
        String(v.action),
      )
    )
      throw error("UNSUPPORTED_ACTION", "unknown transport action")
    if (v.action === "seek" && !id(v.positionMs))
      throw error(
        "INVALID_SEEK",
        "seek position must be a non-negative safe integer",
      )
    if (v.action !== "seek" && "positionMs" in v)
      throw error("INVALID_REQUEST", "only seek accepts positionMs")
    let decoded: TransportRequest
    try {
      decoded = Schema.decodeUnknownSync(TransportRequestSchema)(v)
    } catch {
      throw error("INVALID_REQUEST", "invalid transport request")
    }
    if (decoded.action === "seek") {
      if (!id(decoded.positionMs))
        throw error(
          "INVALID_SEEK",
          "seek position must be a non-negative safe integer",
        )
      return {
        type: "transport",
        requestId: decoded.requestId,
        action: decoded.action,
        positionMs: decoded.positionMs,
      }
    }
    return {
      type: "transport",
      requestId: decoded.requestId,
      action: decoded.action,
    }
  }
  throw error("INVALID_REQUEST", "unknown request type")
}
export function decodeServerFrame(value: unknown): Event | Response {
  const v = record(value)
  if (!v || typeof v.type !== "string")
    throw error("INVALID_REQUEST", "invalid server frame")
  if (v.type === "status") {
    try {
      Schema.decodeUnknownSync(StatusEventSchema)(v)
    } catch {
      throw error("INVALID_REQUEST", "invalid status event")
    }
    const s = record(v.status)
    if (
      !s ||
      !["ready", "degraded", "unavailable"].includes(String(s.kind)) ||
      !(
        s.provider === null ||
        s.provider === "media-control" ||
        s.provider === "nowplaying-cli"
      ) ||
      typeof s.message !== "string"
    )
      throw error("INVALID_REQUEST", "invalid status event")
    // Decode with the declared Effect schema before the typed boundary.
    const status = Schema.decodeUnknownSync(ProviderStatusSchema)(s)
    return { type: "status", status }
  }
  if (v.type === "state") {
    try {
      Schema.decodeUnknownSync(StateEventSchema)(v)
    } catch {
      throw error("INVALID_REQUEST", "invalid state event")
    }
    const s = record(v.snapshot)
    const normalized = s ? player(s.state) : null
    if (
      !s ||
      typeof s.daemonInstanceId !== "string" ||
      !id(s.revision) ||
      !normalized
    )
      throw error("INVALID_REQUEST", "invalid state event")
    return {
      type: "state",
      snapshot: {
        daemonInstanceId: s.daemonInstanceId,
        revision: s.revision,
        state: normalized,
      },
    }
  }
  if (v.type === "response") {
    try {
      Schema.decodeUnknownSync(ResponseSchema)(v)
    } catch {
      throw error("INVALID_REQUEST", "invalid response")
    }
    if (!id(v.requestId) || typeof v.ok !== "boolean")
      throw error("INVALID_REQUEST", "invalid response")
    if (v.ok)
      return {
        type: "response",
        requestId: v.requestId,
        ok: true,
        data: v.data,
      }
    const e = record(v.error)
    if (
      !e ||
      ![
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
      ].includes(String(e.code)) ||
      typeof e.message !== "string" ||
      typeof e.retryable !== "boolean"
    )
      throw error("INVALID_REQUEST", "invalid error response")
    return {
      type: "response",
      requestId: v.requestId,
      ok: false,
      error: Schema.decodeUnknownSync(ErrorSchema)(e),
    }
  }
  throw error("INVALID_REQUEST", "unknown server frame")
}
export function decodeHelloResult(value: unknown): HelloResult {
  try {
    const decoded = Schema.decodeUnknownSync(HelloResultSchema)(value)
    return {
      daemonInstanceId: decoded.daemonInstanceId,
      packageVersion: decoded.packageVersion,
      protocol: {
        major: decoded.protocol.major,
        minor: decoded.protocol.minor,
      },
      capabilities: [...decoded.capabilities],
    }
  } catch {
    throw error("INVALID_REQUEST", "invalid hello result")
  }
}
export function response(requestId: number, data: unknown): Response {
  return { type: "response", requestId, ok: true, data }
}
export function failure(requestId: number, e: ProtocolError): Response {
  return { type: "response", requestId, ok: false, error: e }
}
type _PlayerStateCompatibility =
  RevisionedState["state"] extends CorePlayerState ? true : never
export const playerStateCompatibility: _PlayerStateCompatibility = true
