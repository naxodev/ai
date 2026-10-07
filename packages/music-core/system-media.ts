/**
 * macOS system Now Playing via `media-control` (preferred) or `nowplaying-cli`.
 *
 * media-control exposes a real `playing` boolean — nowplaying-cli often freezes
 * playbackRate/elapsed for apps like Kaset, so the waveform never stopped.
 *
 * Host-neutral: no Bun-only APIs. Inject `run` for tests.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPlaybackClock, trackKey, type PlaybackClock } from "./clock.ts"
import {
  run as defaultRun,
  startLineStream,
  whichOk,
  type CommandResult,
  type LineStreamStarter,
} from "./run.ts"
import type {
  ArtworkIdentity,
  ArtworkResult,
  ProviderStatus,
} from "./session/protocol.ts"
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
  currentStreamState: () => PlayerState | null,
): Promise<PlayerState | null> {
  const r = await runCommand(["media-control", "get", "--no-artwork", "--now"])
  // A startup read may finish after the stream has supplied newer state.
  // Do not decode that stale result into the shared playback clock.
  const streamed = currentStreamState()
  if (streamed) return streamed
  if (!r.ok) return null

  let data: MediaGet | null
  try {
    data = JSON.parse(r.out) as MediaGet | null
  } catch {
    return null
  }
  if (data !== null && (typeof data !== "object" || Array.isArray(data)))
    return null
  return decodeMediaControlSample(data, clock, now())
}

/** Fallback when media-control is missing — weaker play-state. */
async function playerViaNowPlayingCli(
  runCommand: (cmd: string[], timeoutMs?: number) => Promise<CommandResult>,
  clock: PlaybackClock,
  now: () => number,
  currentStreamState: () => PlayerState | null = () => null,
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
  const streamed = currentStreamState()
  if (streamed) return streamed
  const arrival = now()
  if (!r.ok) return null

  let data: Record<string, unknown>
  try {
    data = JSON.parse(r.out) as Record<string, unknown>
  } catch {
    return null
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null

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
  run: (
    cmd: string[],
    timeoutMs?: number,
    maxBufferBytes?: number,
  ) => Promise<CommandResult>
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
  /** Test seam: fits oversized native artwork into the wire budget. */
  shrinkArtwork?: ArtworkShrinker
}

type ResolvedSystemMediaDependencies = SystemMediaDependencies & {
  startLineStream: LineStreamStarter
  setRetryTimer: NonNullable<SystemMediaDependencies["setRetryTimer"]>
  clearRetryTimer: NonNullable<SystemMediaDependencies["clearRetryTimer"]>
  now: () => number
  shrinkArtwork: ArtworkShrinker
}

const retryInitialDelayMs = 1_000
const retryMaximumDelayMs = 8_000

/**
 * Native covers are embedded in `media-control get --now` output, so the read
 * must be bounded well above Node's 1 MiB default. Beyond this the read is
 * truncated and reported as `too-large` rather than surfaced as a failure.
 */
const MAX_NATIVE_ARTWORK_READ_BYTES = 8 * 1024 * 1024
const MAX_NATIVE_ARTWORK_DIMENSION = 4_096
const MAX_NATIVE_ARTWORK_PIXELS = 12_000_000
const ARTWORK_SHRINK_MAX_DIMENSION = 640
const ARTWORK_SHRINK_MIN_DIMENSION = 64
const ARTWORK_SHRINK_ATTEMPTS = 4
const ARTWORK_SHRINK_TIMEOUT_MS = 5_000

/** Fits oversized native artwork into the wire budget; `null` means give up. */
export type ArtworkShrinker = (
  bytes: Uint8Array,
  maxBytes: number,
) => Promise<Uint8Array | null>

/**
 * Downscale with the same macOS `sips` tool the hosts use. Covers are rendered
 * at 300px, so resizing before transport keeps the wire budget small without
 * changing what the user sees.
 */
async function shrinkArtworkWithSips(
  bytes: Uint8Array,
  maxBytes: number,
  runCommand: SystemMediaDependencies["run"],
): Promise<Uint8Array | null> {
  const directory = await mkdtemp(join(tmpdir(), "naxodev-artwork-"))
  try {
    const input = join(directory, "input")
    await writeFile(input, bytes)
    // Inspect metadata before pixel decoding, using the same limits as both hosts.
    const inspected = await runCommand(
      ["sips", "-g", "pixelWidth", "-g", "pixelHeight", input],
      ARTWORK_SHRINK_TIMEOUT_MS,
    )
    if (!inspected.ok) return null
    const width = Number(inspected.out.match(/pixelWidth:\s*(\S+)/)?.[1])
    const height = Number(inspected.out.match(/pixelHeight:\s*(\S+)/)?.[1])
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_NATIVE_ARTWORK_DIMENSION ||
      height > MAX_NATIVE_ARTWORK_DIMENSION ||
      width * height > MAX_NATIVE_ARTWORK_PIXELS
    )
      return null
    let dimension = ARTWORK_SHRINK_MAX_DIMENSION
    for (let attempt = 0; attempt < ARTWORK_SHRINK_ATTEMPTS; attempt++) {
      const output = join(directory, `output-${attempt}.jpg`)
      const converted = await runCommand(
        [
          "sips",
          "-Z",
          String(dimension),
          "-s",
          "format",
          "jpeg",
          input,
          "--out",
          output,
        ],
        ARTWORK_SHRINK_TIMEOUT_MS,
      )
      if (!converted.ok) return null
      let shrunk: Uint8Array
      try {
        shrunk = new Uint8Array(await readFile(output))
      } catch {
        return null
      }
      if (shrunk.byteLength > 0 && shrunk.byteLength <= maxBytes) return shrunk
      dimension = Math.floor(dimension / 2)
      if (dimension < ARTWORK_SHRINK_MIN_DIMENSION) return null
    }
    return null
  } catch {
    return null
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      console.error(
        "Failed to remove temporary artwork directory",
        directory,
        error,
      )
    })
  }
}

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
  /** Health of the latest observation, including the source used for fallback. */
  status?: () => ProviderStatus
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
    shrinkArtwork:
      overrides.shrinkArtwork ??
      ((bytes, maxBytes) =>
        shrinkArtworkWithSips(bytes, maxBytes, overrides.run ?? defaultRun)),
  }
  const clock = createPlaybackClock()

  const kind = deps.detectBackend()
  let observationStatus: ProviderStatus = {
    kind: "unavailable",
    provider: null,
    message: "awaiting provider observation",
  }
  const observed = (provider: "media-control" | "nowplaying-cli") => {
    observationStatus =
      provider === "media-control"
        ? { kind: "ready", provider, message: "media-control ready" }
        : {
            kind: "degraded",
            provider,
            message: "using nowplaying-cli; limited playback state",
          }
  }
  const failedObservation = () => {
    observationStatus = {
      kind: "unavailable",
      provider: null,
      message: "provider sample failed",
    }
  }
  let streamSample: { owner: symbol; state: PlayerState } | null = null
  const currentStreamState = (): PlayerState | null => {
    if (!streamSample) return null
    const { state } = streamSample
    const now = deps.now()
    if (!state.track) return { ...state, fetched_at: now }
    // Reconcile no new provider sample here. The shared clock already owns
    // elapsed time and successful pause, play and seek mutations.
    const { progress_ms, is_playing } = clock.syncFromSample({
      key: trackKey(state.track.name, state.track.artists, state.track.id),
      reported_ms: 0,
      reported: false,
      duration_ms: state.track.duration_ms,
      playing: null,
      rate: NaN,
      now,
    })
    return { ...state, progress_ms, is_playing, fetched_at: now }
  }
  const subscribeWithState = (
    subscribe: typeof subscribeMediaControlAttempt,
    listener: MusicChangeListener,
  ): MusicChangeDisposer => {
    // Only the subscription that supplied the cached sample may clear it.
    const owner = Symbol("media-control stream")
    const invalidate = () => {
      if (streamSample?.owner === owner) streamSample = null
    }
    let dispose: MusicChangeDisposer
    try {
      dispose = subscribe(
        (event) => {
          if (event?.type === "snapshot") {
            streamSample = { owner, state: event.state }
            observed("media-control")
          } else invalidate()
          listener(event)
        },
        deps,
        clock,
      )
    } catch (error) {
      invalidate()
      throw error
    }
    return () => {
      invalidate()
      dispose()
    }
  }
  const backend: SystemMediaAttemptAdapter = {
    status: () => observationStatus,
    id: "system",
    label: "System media",
    remoteControl: true,
    authenticated: () => true,

    async player(): Promise<PlayerState | null> {
      try {
        const kind = deps.detectBackend()
        if (kind === "media-control") {
          const player =
            currentStreamState() ??
            (await playerViaMediaControl(
              deps.run,
              clock,
              deps.now,
              currentStreamState,
            ))
          if (player) {
            observed("media-control")
            return player
          }
          if (deps.hasNowPlayingCli()) {
            const fallback = await playerViaNowPlayingCli(
              deps.run,
              clock,
              deps.now,
              currentStreamState,
            )
            const streamed = currentStreamState()
            if (streamed) {
              observed("media-control")
              return streamed
            }
            if (fallback) observed("nowplaying-cli")
            else failedObservation()
            return (
              fallback ?? idleState("nowplaying-cli error", clock, deps.now())
            )
          }
          failedObservation()
          return idleState("media-control error", clock, deps.now())
        }
        if (kind === "nowplaying-cli") {
          const player = await playerViaNowPlayingCli(deps.run, clock, deps.now)
          if (player) observed("nowplaying-cli")
          else failedObservation()
          return player ?? idleState("nowplaying-cli error", clock, deps.now())
        }
        observationStatus = {
          kind: "unavailable",
          provider: null,
          message: "install media-control or nowplaying-cli",
        }
        return idleState("install media-control", clock, deps.now())
      } catch (error) {
        failedObservation()
        throw error
      }
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
      const before = streamSample
      await cmd("next", deps)
      if (streamSample === before) {
        streamSample = null
        clock.reset()
      }
    },

    async previous() {
      const before = streamSample
      await cmd("previous", deps)
      if (streamSample === before) {
        streamSample = null
        clock.reset()
      }
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
      const result = await deps.run(
        ["media-control", "get", "--now"],
        2_000,
        MAX_NATIVE_ARTWORK_READ_BYTES,
      )
      if (!result.ok) {
        // A truncated read still begins with the provider JSON object. Treat it
        // as an oversized cover so callers fall back instead of reporting a
        // provider failure for a merely large image.
        if (result.err.startsWith("{")) return { type: "too-large" }
        throw new Error(result.err || "media-control artwork failed")
      }
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
      const decodedBytes = (base64.length / 4) * 3 - padding
      if (decodedBytes <= maxBytes) {
        // The bounded decode is only for canonicality; it cannot allocate above maxBytes.
        if (Buffer.from(base64, "base64").toString("base64") !== base64)
          return { type: "unavailable" }
        return { type: "available", base64 }
      }
      // Oversized covers are downscaled before transport so the wire budget
      // stays small; only an unshrinkable image is rejected.
      const shrunk = await deps.shrinkArtwork(
        new Uint8Array(Buffer.from(base64, "base64")),
        maxBytes,
      )
      return shrunk && shrunk.byteLength > 0 && shrunk.byteLength <= maxBytes
        ? { type: "available", base64: Buffer.from(shrunk).toString("base64") }
        : { type: "too-large" }
    }
    backend.subscribe = (listener) =>
      subscribeWithState(subscribeToMediaControl, listener)
    // The daemon uses this unsupervised seam. It shares this exact backend's
    // playback clock and stream state with sampling and transport.
    backend.subscribeAttempt = (listener) =>
      subscribeWithState(subscribeMediaControlAttempt, listener)
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
