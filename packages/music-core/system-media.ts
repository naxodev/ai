/**
 * macOS system Now Playing via `media-control` (preferred) or `nowplaying-cli`.
 *
 * media-control exposes a real `playing` boolean — nowplaying-cli often freezes
 * playbackRate/elapsed for apps like Kaset, so the waveform never stopped.
 *
 * Host-neutral: no artwork, no Bun-only APIs. Inject `run` for tests.
 */
import { createPlaybackClock, trackKey, type PlaybackClock } from "./clock.ts"
import {
  run as defaultRun,
  startLineStream,
  whichOk,
  type CommandResult,
  type LineStreamStarter,
} from "./run.ts"
import type { ArtworkIdentity, ArtworkResult } from "./session/protocol.ts"
import {
  emptyPlayer,
  type MusicBackend,
  type MusicChangeDisposer,
  type MusicChangeListener,
  type MusicError,
  type PlayerState,
} from "./types.ts"

type MediaGet = {
  title?: string | null
  artist?: string | null
  album?: string | null
  duration?: number | null
  elapsedTime?: number | null
  elapsedTimeNow?: number | null
  playbackRate?: number | null
  playing?: boolean | null
  bundleIdentifier?: string | null
  parentApplicationBundleIdentifier?: string | null
  contentItemIdentifier?: string | null
  timestamp?: string | null
  artworkData?: string | null
}

let backendKind: "media-control" | "nowplaying-cli" | null = null

/** Test seam: clear cached preferred backend between cases. */
export function resetMediaBackend(): void {
  backendKind = null
}

function detectBackend(): "media-control" | "nowplaying-cli" | null {
  if (backendKind) return backendKind
  if (whichOk("media-control")) {
    backendKind = "media-control"
    return backendKind
  }
  if (whichOk("nowplaying-cli")) {
    backendKind = "nowplaying-cli"
    return backendKind
  }
  return null
}

export function bundleLabel(bundle: string | null | undefined): string {
  if (!bundle) return "System media"
  if (bundle.includes("Spotify")) return "Spotify"
  if (bundle.includes("Music")) return "Apple Music"
  if (bundle.includes("WebKit") || bundle.includes("Safari")) return "Browser"
  if (bundle.includes("Chrome")) return "Chrome"
  if (bundle.includes("Kaset")) return "Kaset"
  if (bundle.includes("youtube") || bundle.includes("YouTube")) return "YouTube"
  const short = bundle.split(".").pop()
  return short || "System media"
}

/** Prefer parentApplicationBundleIdentifier (real app) over WebKit GPU bundle. */
export function effectiveBundle(data: {
  bundleIdentifier?: string | null
  parentApplicationBundleIdentifier?: string | null
}): string | null {
  const parent = data.parentApplicationBundleIdentifier
  const bundle = data.bundleIdentifier
  if (parent != null && parent !== "") return String(parent)
  if (bundle != null && bundle !== "") return String(bundle)
  return null
}

function idleState(
  name: string,
  clock: PlaybackClock,
  now: number = Date.now(),
): PlayerState {
  clock.reset()
  return {
    ...emptyPlayer(),
    fetched_at: now,
    device: {
      id: "system",
      name,
      type: "Computer",
      is_active: false,
      volume_percent: null,
      supports_volume: false,
    },
  }
}

function buildState(opts: {
  provider_id: string
  title: string
  artist: string
  album: string
  duration_ms: number
  progress_ms: number
  is_playing: boolean
  now: number
  bundle: string | null
}): PlayerState {
  return {
    is_playing: opts.is_playing,
    progress_ms: opts.progress_ms,
    shuffle: false,
    repeat: "off",
    device: {
      id: "system",
      name: bundleLabel(opts.bundle),
      type: "Computer",
      is_active: true,
      volume_percent: null,
      supports_volume: false,
    },
    track: {
      id: opts.provider_id,
      uri: `system:now:${encodeURIComponent(opts.title)}`,
      name: opts.title,
      artists: opts.artist,
      album: opts.album,
      duration_ms: opts.duration_ms,
    },
    fetched_at: opts.now,
  }
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value))
}

function isContentItemIdentifier(value: unknown): boolean {
  return (
    value === null || typeof value === "string" || typeof value === "number"
  )
}

/**
 * True when a stream payload has the complete sample shape with correct types.
 * Values may be empty or null (idle). Partial objects must not emit.
 */
function isAuthoritativeMediaPayload(
  data: Record<string, unknown>,
): data is MediaGet & Record<string, unknown> {
  if (!("title" in data) || !isStringOrNull(data.title)) return false
  if (!("artist" in data) || !isStringOrNull(data.artist)) return false
  if (!("album" in data) || !isStringOrNull(data.album)) return false
  if (!("duration" in data) || !isFiniteNumberOrNull(data.duration))
    return false
  if (!("playing" in data) || typeof data.playing !== "boolean") return false
  if (
    !("contentItemIdentifier" in data) ||
    !isContentItemIdentifier(data.contentItemIdentifier)
  ) {
    return false
  }

  const hasElapsedNow = "elapsedTimeNow" in data
  const hasElapsed = "elapsedTime" in data
  if (!hasElapsedNow && !hasElapsed) return false
  if (hasElapsedNow && !isFiniteNumberOrNull(data.elapsedTimeNow)) return false
  if (hasElapsed && !isFiniteNumberOrNull(data.elapsedTime)) return false

  return true
}

/**
 * Shared media-control decoder for `get` objects and complete stream payloads.
 * Captures one arrival timestamp for clock reconciliation and `fetched_at`.
 */
function decodeMediaControlSample(
  data: MediaGet | null,
  clock: PlaybackClock,
  now: number,
): PlayerState {
  if (!data) return idleState("Nothing playing", clock, now)

  const title = data.title != null ? String(data.title) : ""
  const artist = data.artist != null ? String(data.artist) : ""
  const album = data.album != null ? String(data.album) : ""
  const durationSec =
    typeof data.duration === "number" && Number.isFinite(data.duration)
      ? data.duration
      : 0
  const hasReported =
    (typeof data.elapsedTimeNow === "number" &&
      Number.isFinite(data.elapsedTimeNow)) ||
    (typeof data.elapsedTime === "number" && Number.isFinite(data.elapsedTime))
  const elapsedSec =
    typeof data.elapsedTimeNow === "number" &&
    Number.isFinite(data.elapsedTimeNow)
      ? data.elapsedTimeNow
      : typeof data.elapsedTime === "number" &&
          Number.isFinite(data.elapsedTime)
        ? data.elapsedTime
        : 0
  const rate =
    typeof data.playbackRate === "number" && Number.isFinite(data.playbackRate)
      ? data.playbackRate
      : NaN
  const playing = typeof data.playing === "boolean" ? data.playing : null
  const uid =
    data.contentItemIdentifier != null ? String(data.contentItemIdentifier) : ""
  if (!title && !artist && !album && !uid && data.playing !== true)
    return idleState("Nothing playing", clock, now)
  const bundle = effectiveBundle(data)

  const duration_ms = Math.round(durationSec * 1000)
  const reported_ms = Math.round(elapsedSec * 1000)
  const key = trackKey(title, artist, uid)
  const { progress_ms, is_playing } = clock.syncFromSample({
    key,
    reported_ms,
    reported: hasReported,
    duration_ms,
    playing,
    rate,
    now,
  })

  return buildState({
    provider_id: uid,
    title,
    artist,
    album,
    duration_ms,
    progress_ms,
    is_playing,
    now,
    bundle,
  })
}

async function playerViaMediaControl(
  runCommand: (cmd: string[], timeoutMs?: number) => Promise<CommandResult>,
  clock: PlaybackClock,
  now: () => number,
): Promise<PlayerState | null> {
  const r = await runCommand(["media-control", "get", "--no-artwork", "--now"])
  if (!r.ok) return null

  let data: MediaGet | null
  try {
    data = JSON.parse(r.out) as MediaGet | null
  } catch {
    return null
  }
  return decodeMediaControlSample(data, clock, now())
}

/** Fallback when media-control is missing — weaker play-state. */
async function playerViaNowPlayingCli(
  runCommand: (cmd: string[], timeoutMs?: number) => Promise<CommandResult>,
  clock: PlaybackClock,
  now: () => number,
): Promise<PlayerState | null> {
  const r = await runCommand([
    "nowplaying-cli",
    "get",
    "--json",
    "title",
    "artist",
    "album",
    "duration",
    "elapsedTime",
    "playbackRate",
    "isPlaying",
  ])
  const arrival = now()
  if (!r.ok) return idleState("nowplaying-cli error", clock, arrival)

  let data: Record<string, unknown>
  try {
    data = JSON.parse(r.out) as Record<string, unknown>
  } catch {
    return idleState("nowplaying-cli error", clock, arrival)
  }

  const title =
    data.title != null && data.title !== "null" ? String(data.title) : ""
  const artist =
    data.artist != null && data.artist !== "null" ? String(data.artist) : ""
  const album =
    data.album != null && data.album !== "null" ? String(data.album) : ""
  const durationSec = Number(data.duration) || 0
  const elapsedValue = Number(data.elapsedTime)
  const hasReported =
    data.elapsedTime != null &&
    data.elapsedTime !== "null" &&
    Number.isFinite(elapsedValue)
  const elapsedSec = hasReported ? elapsedValue : 0
  const rate = Number(data.playbackRate)
  let playing: boolean | null = null
  if (
    data.isPlaying === true ||
    data.isPlaying === 1 ||
    data.isPlaying === "1"
  ) {
    playing = true
  } else if (
    data.isPlaying === false ||
    data.isPlaying === 0 ||
    data.isPlaying === "0"
  ) {
    playing = false
  }
  if (!title && !artist && !album && playing !== true)
    return idleState("Nothing playing", clock, arrival)

  const duration_ms = Math.round(durationSec * 1000)
  const reported_ms = Math.round(elapsedSec * 1000)
  const key = trackKey(title, artist, "")
  const { progress_ms, is_playing } = clock.syncFromSample({
    key,
    reported_ms,
    reported: hasReported,
    duration_ms,
    playing,
    rate: Number.isFinite(rate) ? rate : NaN,
    now: arrival,
  })

  return buildState({
    provider_id: "",
    title,
    artist,
    album,
    duration_ms,
    progress_ms,
    is_playing,
    now: arrival,
    bundle: null,
  })
}

export type SystemMediaDependencies = {
  run: (cmd: string[], timeoutMs?: number) => Promise<CommandResult>
  detectBackend: () => "media-control" | "nowplaying-cli" | null
  hasNowPlayingCli: () => boolean
  startLineStream?: LineStreamStarter
  setRetryTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>
  clearRetryTimer?: (timer: ReturnType<typeof setTimeout>) => void
  /** Test seam: fixed arrival time for deterministic stream/player samples. */
  now?: () => number
}

type ResolvedSystemMediaDependencies = SystemMediaDependencies & {
  startLineStream: LineStreamStarter
  setRetryTimer: NonNullable<SystemMediaDependencies["setRetryTimer"]>
  clearRetryTimer: NonNullable<SystemMediaDependencies["clearRetryTimer"]>
  now: () => number
}

const retryInitialDelayMs = 1_000
const retryMaximumDelayMs = 8_000

function isDataEnvelope(
  value: unknown,
): value is { type: "data"; payload: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const envelope = value as { type?: unknown; payload?: unknown }
  return (
    envelope.type === "data" &&
    typeof envelope.payload === "object" &&
    envelope.payload !== null &&
    !Array.isArray(envelope.payload)
  )
}

/** One raw `media-control stream` attempt. It deliberately owns no retry timer. */
export type SystemMediaAttemptAdapter = MusicBackend & {
  subscribeAttempt?: (listener: MusicChangeListener) => MusicChangeDisposer
  nativeArtwork?: (
    identity: ArtworkIdentity,
    maxBytes: number,
  ) => Promise<ArtworkResult>
}

function subscribeMediaControlAttempt(
  listener: MusicChangeListener,
  deps: ResolvedSystemMediaDependencies,
  clock: PlaybackClock,
): MusicChangeDisposer {
  let disposed = false
  let terminal = false
  let source: MusicChangeDisposer | undefined
  let sourceDisposed = false
  let terminalDisposalFailure: unknown
  const disposeSource = () => {
    if (sourceDisposed || !source) return
    sourceDisposed = true
    source()
  }
  const stop = () => {
    if (!disposed) {
      disposed = true
      disposeSource()
      return
    }
    // A terminal must not suppress its invalidation merely because the raw
    // process disposer threw. Surface that one recorded failure to the Effect
    // owner when it performs scoped cleanup.
    if (terminalDisposalFailure !== undefined) {
      const failure = terminalDisposalFailure
      terminalDisposalFailure = undefined
      throw failure
    }
  }
  source = deps.startLineStream(
    ["media-control", "stream", "--no-diff", "--no-artwork"],
    {
      onLine(line) {
        if (disposed) return
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          return
        }
        if (
          !isDataEnvelope(parsed) ||
          !isAuthoritativeMediaPayload(parsed.payload)
        )
          return
        listener({
          type: "snapshot",
          state: decodeMediaControlSample(parsed.payload, clock, deps.now()),
        })
      },
      onTerminal() {
        if (disposed || terminal) return
        terminal = true
        // Terminal owns the sole source disposal. Marking the attempt disposed
        // also suppresses every late line callback and makes scope cleanup a no-op.
        disposed = true
        try {
          disposeSource()
        } catch (cause) {
          terminalDisposalFailure = cause
        }
        // Notify before surfacing a disposal failure through the returned
        // disposer: provider supervision must never be stranded waiting for
        // this terminal transition.
        listener({ type: "invalidation", reason: "stream-terminated" })
      },
    },
  )
  if (disposed) {
    try {
      disposeSource()
    } catch (cause) {
      terminalDisposalFailure ??= cause
    }
  }
  return stop
}

function subscribeToMediaControl(
  listener: MusicChangeListener,
  deps: ResolvedSystemMediaDependencies,
  clock: PlaybackClock,
): MusicChangeDisposer {
  let disposed = false
  let streamDisposer: MusicChangeDisposer | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryDelayMs = retryInitialDelayMs
  let generation = 0

  const start = () => {
    if (disposed) return
    const currentGeneration = ++generation
    let sourceDisposer: MusicChangeDisposer | null = null
    let terminalHandled = false

    const handleTerminal = () => {
      if (
        disposed ||
        currentGeneration !== generation ||
        terminalHandled ||
        retryTimer !== null
      ) {
        return
      }
      terminalHandled = true
      const terminalGeneration = ++generation
      sourceDisposer?.()
      if (streamDisposer === sourceDisposer) streamDisposer = null
      listener({ type: "invalidation", reason: "stream-terminated" })
      if (disposed || generation !== terminalGeneration) return
      const delayMs = retryDelayMs
      retryDelayMs = Math.min(retryDelayMs * 2, retryMaximumDelayMs)
      retryTimer = deps.setRetryTimer(() => {
        retryTimer = null
        start()
      }, delayMs)
    }

    sourceDisposer = deps.startLineStream(
      ["media-control", "stream", "--no-diff", "--no-artwork"],
      {
        onLine(line) {
          if (disposed || currentGeneration !== generation) return
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            return
          }
          if (!isDataEnvelope(parsed)) return
          if (!isAuthoritativeMediaPayload(parsed.payload)) return
          const now = deps.now()
          const state = decodeMediaControlSample(parsed.payload, clock, now)
          retryDelayMs = retryInitialDelayMs
          listener({ type: "snapshot", state })
        },
        onTerminal: handleTerminal,
      },
    )
    if (disposed || currentGeneration !== generation) {
      sourceDisposer()
      return
    }
    streamDisposer = sourceDisposer
  }

  start()
  return () => {
    if (disposed) return
    disposed = true
    generation++
    if (retryTimer !== null) deps.clearRetryTimer(retryTimer)
    retryTimer = null
    streamDisposer?.()
    streamDisposer = null
  }
}

async function cmd(
  action: string,
  deps: ResolvedSystemMediaDependencies,
): Promise<void> {
  const kind = deps.detectBackend()
  if (kind === "media-control") {
    const map: Record<string, string[]> = {
      play: ["media-control", "play"],
      pause: ["media-control", "pause"],
      next: ["media-control", "next-track"],
      previous: ["media-control", "previous-track"],
    }
    const c = map[action]
    if (!c)
      throw { status: 500, message: `unknown ${action}` } satisfies MusicError
    const r = await deps.run(c)
    if (!r.ok) throw { status: 500, message: r.err } satisfies MusicError
    return
  }
  if (kind === "nowplaying-cli") {
    const map: Record<string, string[]> = {
      play: ["nowplaying-cli", "play"],
      pause: ["nowplaying-cli", "pause"],
      next: ["nowplaying-cli", "next"],
      previous: ["nowplaying-cli", "previous"],
    }
    const c = map[action]
    if (!c)
      throw { status: 500, message: `unknown ${action}` } satisfies MusicError
    const r = await deps.run(c)
    if (!r.ok) throw { status: 500, message: r.err } satisfies MusicError
    return
  }
  throw {
    status: 500,
    message: "install media-control or nowplaying-cli",
  } satisfies MusicError
}

export function createSystemMedia(
  overrides: Partial<SystemMediaDependencies> = {},
): MusicBackend {
  const deps: ResolvedSystemMediaDependencies = {
    run: defaultRun,
    detectBackend,
    hasNowPlayingCli,
    ...overrides,
    startLineStream: overrides.startLineStream ?? startLineStream,
    setRetryTimer: overrides.setRetryTimer ?? setTimeout,
    clearRetryTimer: overrides.clearRetryTimer ?? clearTimeout,
    now: overrides.now ?? Date.now,
  }
  const clock = createPlaybackClock()

  const kind = deps.detectBackend()
  const backend: MusicBackend = {
    id: "system",
    label: "System media",
    remoteControl: true,
    authenticated: () => true,

    async player(): Promise<PlayerState | null> {
      const kind = deps.detectBackend()
      if (kind === "media-control") {
        const player = await playerViaMediaControl(deps.run, clock, deps.now)
        if (player) return player
        if (deps.hasNowPlayingCli())
          return playerViaNowPlayingCli(deps.run, clock, deps.now)
        return idleState("media-control error", clock, deps.now())
      }
      if (kind === "nowplaying-cli")
        return playerViaNowPlayingCli(deps.run, clock, deps.now)
      return idleState("install media-control", clock, deps.now())
    },

    async play() {
      await cmd("play", deps)
      clock.setPlaying(true, deps.now())
    },

    async pause() {
      await cmd("pause", deps)
      clock.setPlaying(false, deps.now())
    },

    async next() {
      await cmd("next", deps)
      clock.reset()
    },

    async previous() {
      await cmd("previous", deps)
      clock.reset()
    },

    async seek(positionMs: number) {
      const sec = Math.max(0, positionMs / 1000)
      const kind = deps.detectBackend()
      if (kind === "media-control") {
        const r = await deps.run(["media-control", "seek", String(sec)])
        if (!r.ok) throw { status: 500, message: r.err } satisfies MusicError
        clock.seek(positionMs, deps.now())
        return
      }
      if (kind === "nowplaying-cli") {
        const r = await deps.run([
          "nowplaying-cli",
          "seek",
          String(Math.floor(sec)),
        ])
        if (!r.ok) throw { status: 500, message: r.err } satisfies MusicError
        clock.seek(positionMs, deps.now())
        return
      }
      throw {
        status: 500,
        message: "install media-control or nowplaying-cli",
      } satisfies MusicError
    },
  }

  if (kind === "media-control") {
    ;(backend as SystemMediaAttemptAdapter).nativeArtwork = async (
      identity,
      maxBytes,
    ) => {
      const result = await deps.run(["media-control", "get", "--now"])
      if (!result.ok)
        throw new Error(result.err || "media-control artwork failed")
      // Reject encoded output before JSON/base64 retention.
      if (
        Buffer.byteLength(result.out, "utf8") >
        Math.ceil(maxBytes / 3) * 4 + 8 * 1024
      )
        return { type: "too-large" }
      let data: MediaGet
      try {
        const parsed: unknown = JSON.parse(result.out)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          return { type: "unavailable" }
        data = parsed as MediaGet
      } catch {
        return { type: "unavailable" }
      }
      if (
        data.contentItemIdentifier === null ||
        data.contentItemIdentifier === undefined
      )
        return { type: "stale" }
      const nativeIdentity = {
        id: String(data.contentItemIdentifier),
        name: data.title == null ? "" : String(data.title),
        artists: data.artist == null ? "" : String(data.artist),
        album: data.album == null ? "" : String(data.album),
        duration_ms:
          typeof data.duration === "number" && Number.isFinite(data.duration)
            ? Math.round(data.duration * 1000)
            : 0,
      }
      if (
        Object.keys(identity).some(
          (key) =>
            nativeIdentity[key as keyof typeof nativeIdentity] !==
            identity[key as keyof ArtworkIdentity],
        )
      )
        return { type: "stale" }
      const base64 = data.artworkData
      if (
        typeof base64 !== "string" ||
        !base64 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
        base64.length % 4 !== 0
      )
        return { type: "unavailable" }
      const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
      if ((base64.length / 4) * 3 - padding > maxBytes)
        return { type: "too-large" }
      // The bounded decode is only for canonicality; it cannot allocate above maxBytes.
      if (Buffer.from(base64, "base64").toString("base64") !== base64)
        return { type: "unavailable" }
      return { type: "available", base64 }
    }
    backend.subscribe = (listener) =>
      subscribeToMediaControl(listener, deps, clock)
    // The daemon uses this unsupervised seam. It shares this exact backend's
    // playback clock with polling and transport; legacy hosts keep `subscribe`.
    ;(backend as SystemMediaAttemptAdapter).subscribeAttempt = (listener) =>
      subscribeMediaControlAttempt(listener, deps, clock)
  }
  return backend
}

/** Creates one adapter whose sampling, transports and raw stream share a clock. */
export function createSystemMediaAdapter(
  overrides: Partial<SystemMediaDependencies> = {},
): SystemMediaAttemptAdapter {
  return createSystemMedia(overrides) as SystemMediaAttemptAdapter
}

export function hasMediaControl(): boolean {
  return whichOk("media-control")
}

export function hasNowPlayingCli(): boolean {
  return whichOk("nowplaying-cli")
}
