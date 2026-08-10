/**
 * macOS system Now Playing via `media-control` (preferred) or `nowplaying-cli`.
 *
 * media-control exposes a real `playing` boolean — nowplaying-cli often freezes
 * playbackRate/elapsed for apps like Kaset, so the waveform never stopped.
 *
 * Host-neutral: no artwork, no Bun-only APIs. Inject `run` for tests.
 */
import {
  resetClock,
  seekClock,
  setClockPlaying,
  syncFromSample,
  trackKey,
} from "./clock.ts"
import {
  run as defaultRun,
  startLineStream,
  whichOk,
  type CommandResult,
  type LineStreamStarter,
} from "./run.ts"
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

function idleState(name: string): PlayerState {
  resetClock()
  return {
    ...emptyPlayer(),
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

async function playerViaMediaControl(
  runCommand: (cmd: string[], timeoutMs?: number) => Promise<CommandResult>,
): Promise<PlayerState | null> {
  const r = await runCommand(["media-control", "get", "--no-artwork", "--now"])
  if (!r.ok) return null

  let data: MediaGet | null
  try {
    data = JSON.parse(r.out) as MediaGet | null
  } catch {
    return null
  }
  if (!data) return idleState("Nothing playing")

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
    return idleState("Nothing playing")
  const bundle = effectiveBundle(data)

  const duration_ms = Math.round(durationSec * 1000)
  const reported_ms = Math.round(elapsedSec * 1000)
  const now = Date.now()
  const key = trackKey(title, artist, uid)
  const { progress_ms, is_playing } = syncFromSample({
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

/** Fallback when media-control is missing — weaker play-state. */
async function playerViaNowPlayingCli(
  runCommand: (cmd: string[], timeoutMs?: number) => Promise<CommandResult>,
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
  if (!r.ok) return idleState("nowplaying-cli error")

  let data: Record<string, unknown>
  try {
    data = JSON.parse(r.out) as Record<string, unknown>
  } catch {
    return idleState("nowplaying-cli error")
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
    return idleState("Nothing playing")

  const duration_ms = Math.round(durationSec * 1000)
  const reported_ms = Math.round(elapsedSec * 1000)
  const now = Date.now()
  const key = trackKey(title, artist, "")
  const { progress_ms, is_playing } = syncFromSample({
    key,
    reported_ms,
    reported: hasReported,
    duration_ms,
    playing,
    rate: Number.isFinite(rate) ? rate : NaN,
    now,
  })

  return buildState({
    provider_id: "",
    title,
    artist,
    album,
    duration_ms,
    progress_ms,
    is_playing,
    now,
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
}

type ResolvedSystemMediaDependencies = SystemMediaDependencies & {
  startLineStream: LineStreamStarter
  setRetryTimer: NonNullable<SystemMediaDependencies["setRetryTimer"]>
  clearRetryTimer: NonNullable<SystemMediaDependencies["clearRetryTimer"]>
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

function subscribeToMediaControl(
  listener: MusicChangeListener,
  deps: ResolvedSystemMediaDependencies,
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
    sourceDisposer = deps.startLineStream(
      ["media-control", "stream", "--no-diff", "--no-artwork"],
      {
        onLine(line) {
          if (disposed || currentGeneration !== generation) return
          try {
            if (!isDataEnvelope(JSON.parse(line))) return
          } catch {
            return
          }
          retryDelayMs = retryInitialDelayMs
          listener()
        },
        onTerminal() {
          if (
            disposed ||
            currentGeneration !== generation ||
            retryTimer !== null
          ) {
            return
          }
          generation++
          sourceDisposer?.()
          if (streamDisposer === sourceDisposer) streamDisposer = null
          const delayMs = retryDelayMs
          retryDelayMs = Math.min(retryDelayMs * 2, retryMaximumDelayMs)
          retryTimer = deps.setRetryTimer(() => {
            retryTimer = null
            start()
          }, delayMs)
        },
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
  }

  const kind = deps.detectBackend()
  const backend: MusicBackend = {
    id: "system",
    label: "System media",
    remoteControl: true,
    authenticated: () => true,

    async player(): Promise<PlayerState | null> {
      const kind = deps.detectBackend()
      if (kind === "media-control") {
        const player = await playerViaMediaControl(deps.run)
        if (player) return player
        if (deps.hasNowPlayingCli()) return playerViaNowPlayingCli(deps.run)
        return idleState("media-control error")
      }
      if (kind === "nowplaying-cli") return playerViaNowPlayingCli(deps.run)
      return idleState("install media-control")
    },

    async play() {
      await cmd("play", deps)
      setClockPlaying(true)
    },

    async pause() {
      await cmd("pause", deps)
      setClockPlaying(false)
    },

    async next() {
      await cmd("next", deps)
      resetClock()
    },

    async previous() {
      await cmd("previous", deps)
      resetClock()
    },

    async seek(positionMs: number) {
      const sec = Math.max(0, positionMs / 1000)
      const kind = deps.detectBackend()
      if (kind === "media-control") {
        const r = await deps.run(["media-control", "seek", String(sec)])
        if (!r.ok) throw { status: 500, message: r.err } satisfies MusicError
        seekClock(positionMs)
        return
      }
      if (kind === "nowplaying-cli") {
        const r = await deps.run([
          "nowplaying-cli",
          "seek",
          String(Math.floor(sec)),
        ])
        if (!r.ok) throw { status: 500, message: r.err } satisfies MusicError
        seekClock(positionMs)
      }
    },
  }

  if (kind === "media-control") {
    backend.subscribe = (listener) => subscribeToMediaControl(listener, deps)
  }
  return backend
}

export function hasMediaControl(): boolean {
  return whichOk("media-control")
}

export function hasNowPlayingCli(): boolean {
  return whichOk("nowplaying-cli")
}
