/**
 * macOS system Now Playing via `media-control` (preferred) or `nowplaying-cli`.
 *
 * media-control exposes a real `playing` boolean — nowplaying-cli often freezes
 * playbackRate/elapsed for apps like Kaset, so the waveform never stopped.
 */
import {
  emptyPlayer,
  type MusicBackend,
  type MusicError,
  type PlayerState,
  type Track,
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
  contentItemIdentifier?: string | null
  timestamp?: string | null
}

export type Clock = {
  trackKey: string
  anchor_ms: number
  wall_ms: number
  playing: boolean
}

let clock: Clock | null = null
let backendKind: "media-control" | "nowplaying-cli" | null = null

async function run(
  cmd: string[],
): Promise<{ ok: true; out: string } | { ok: false; err: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      return {
        ok: false,
        err: stderr.trim() || stdout.trim() || `exit ${code}`,
      }
    }
    return { ok: true, out: stdout.trim() }
  } catch (e) {
    return { ok: false, err: String(e) }
  }
}

function detectBackend(): "media-control" | "nowplaying-cli" | null {
  if (backendKind) return backendKind
  if (Bun.spawnSync(["which", "media-control"]).exitCode === 0) {
    backendKind = "media-control"
    return backendKind
  }
  if (Bun.spawnSync(["which", "nowplaying-cli"]).exitCode === 0) {
    backendKind = "nowplaying-cli"
    return backendKind
  }
  return null
}

export function liveFromClock(
  c: Clock,
  now: number,
  duration_ms: number,
): number {
  const raw = c.playing ? c.anchor_ms + (now - c.wall_ms) : c.anchor_ms
  if (duration_ms > 0) return Math.max(0, Math.min(duration_ms, raw))
  return Math.max(0, raw)
}

function freezeClock(now: number) {
  if (!clock) return
  clock.anchor_ms = liveFromClock(clock, now, 0)
  clock.wall_ms = now
}

function setPlaying(playing: boolean) {
  const now = Date.now()
  if (!clock) {
    clock = { trackKey: "", anchor_ms: 0, wall_ms: now, playing }
    return
  }
  freezeClock(now)
  clock.playing = playing
}

export function trackKey(title: string, artist: string, uid: string): string {
  return uid || `${title}\0${artist}`
}

/**
 * Progress + play state.
 * Prefer the CLI's `playing` when present; otherwise fall back to rate + sticky clock.
 */
function syncFromSample(opts: {
  key: string
  reported_ms: number
  duration_ms: number
  playing: boolean | null
  rate: number
  now: number
}): { progress_ms: number; is_playing: boolean } {
  const { key, reported_ms, duration_ms, now } = opts
  const hasReported = reported_ms > 0

  let isPlaying: boolean
  if (opts.playing === true || opts.playing === false) {
    isPlaying = opts.playing
  } else if (Number.isFinite(opts.rate)) {
    isPlaying = opts.rate > 0.01
  } else {
    isPlaying = clock?.trackKey === key ? clock.playing : true
  }

  if (!clock || clock.trackKey !== key) {
    clock = {
      trackKey: key,
      anchor_ms: hasReported ? reported_ms : 0,
      wall_ms: now,
      playing: isPlaying,
    }
    return {
      progress_ms: liveFromClock(clock, now, duration_ms),
      is_playing: isPlaying,
    }
  }

  if (isPlaying !== clock.playing) {
    freezeClock(now)
    if (isPlaying && hasReported) {
      clock.anchor_ms = reported_ms
      clock.wall_ms = now
    }
    clock.playing = isPlaying
  }

  if (hasReported && isPlaying) {
    const estimated = liveFromClock(clock, now, duration_ms)
    const delta = reported_ms - estimated
    if (Math.abs(delta) >= 400) {
      clock.anchor_ms = reported_ms
      clock.wall_ms = now
    }
  } else if (hasReported && !isPlaying) {
    clock.anchor_ms = reported_ms
    clock.wall_ms = now
  }

  return {
    progress_ms: liveFromClock(clock, now, duration_ms),
    is_playing: isPlaying,
  }
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

function idleState(name: string): PlayerState {
  clock = null
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
  key: string
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
      id: opts.key,
      uri: `system:now:${encodeURIComponent(opts.title)}`,
      name: opts.title,
      artists: opts.artist,
      album: opts.album,
      duration_ms: opts.duration_ms,
    },
    fetched_at: opts.now,
  }
}

async function playerViaMediaControl(): Promise<PlayerState | null> {
  const r = await run(["media-control", "get", "--no-artwork", "--now"])
  if (!r.ok) return null

  let data: MediaGet | null
  try {
    data = JSON.parse(r.out) as MediaGet | null
  } catch {
    return null
  }
  if (!data || !data.title) return idleState("Nothing playing")

  const title = String(data.title)
  const artist = data.artist != null ? String(data.artist) : ""
  const album = data.album != null ? String(data.album) : ""
  const durationSec =
    typeof data.duration === "number" && Number.isFinite(data.duration)
      ? data.duration
      : 0
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
  const bundle =
    data.bundleIdentifier != null ? String(data.bundleIdentifier) : null

  const duration_ms = Math.round(durationSec * 1000)
  const reported_ms = Math.round(elapsedSec * 1000)
  const now = Date.now()
  const key = trackKey(title, artist, uid)
  const { progress_ms, is_playing } = syncFromSample({
    key,
    reported_ms,
    duration_ms,
    playing,
    rate,
    now,
  })

  return buildState({
    key,
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
async function playerViaNowPlayingCli(): Promise<PlayerState | null> {
  const r = await run([
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
  if (!title) return idleState("Nothing playing")

  const artist =
    data.artist != null && data.artist !== "null" ? String(data.artist) : ""
  const album =
    data.album != null && data.album !== "null" ? String(data.album) : ""
  const durationSec = Number(data.duration) || 0
  const elapsedSec = Number(data.elapsedTime) || 0
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

  const duration_ms = Math.round(durationSec * 1000)
  const reported_ms = Math.round(elapsedSec * 1000)
  const now = Date.now()
  const key = trackKey(title, artist, "")
  const { progress_ms, is_playing } = syncFromSample({
    key,
    reported_ms,
    duration_ms,
    playing,
    rate: Number.isFinite(rate) ? rate : NaN,
    now,
  })

  return buildState({
    key,
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

async function cmd(action: string): Promise<void> {
  const kind = detectBackend()
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
    const r = await run(c)
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
    const r = await run(c)
    if (!r.ok) throw { status: 500, message: r.err } satisfies MusicError
    return
  }
  throw {
    status: 500,
    message: "install media-control or nowplaying-cli",
  } satisfies MusicError
}

export function createSystemMedia(): MusicBackend {
  return {
    id: "system",
    label: "System media",
    remoteControl: true,
    authenticated: () => true,

    async player(): Promise<PlayerState | null> {
      const kind = detectBackend()
      if (kind === "media-control") return playerViaMediaControl()
      if (kind === "nowplaying-cli") return playerViaNowPlayingCli()
      return idleState("install media-control")
    },

    async searchTracks(): Promise<Track[]> {
      throw {
        status: 501,
        message: "Search in the app that's playing",
      } satisfies MusicError
    },

    async play() {
      setPlaying(true)
      await cmd("play")
    },

    async pause() {
      setPlaying(false)
      await cmd("pause")
    },

    async next() {
      clock = null
      await cmd("next")
    },

    async previous() {
      clock = null
      await cmd("previous")
    },

    async seek(positionMs: number) {
      const sec = Math.max(0, positionMs / 1000)
      const now = Date.now()
      if (clock) {
        clock.anchor_ms = Math.max(0, positionMs)
        clock.wall_ms = now
      } else {
        clock = {
          trackKey: "",
          anchor_ms: Math.max(0, positionMs),
          wall_ms: now,
          playing: true,
        }
      }
      const kind = detectBackend()
      if (kind === "media-control") {
        const r = await run(["media-control", "seek", String(sec)])
        if (!r.ok) throw { status: 500, message: r.err } satisfies MusicError
        return
      }
      if (kind === "nowplaying-cli") {
        const r = await run(["nowplaying-cli", "seek", String(Math.floor(sec))])
        if (!r.ok) throw { status: 500, message: r.err } satisfies MusicError
      }
    },
  }
}

export function openNowPlayingApp() {
  Bun.spawn(["open", "https://music.youtube.com"], {
    stdout: "ignore",
    stderr: "ignore",
  })
}

export function hasMediaControl(): boolean {
  return Bun.spawnSync(["which", "media-control"]).exitCode === 0
}

export function hasNowPlayingCli(): boolean {
  return Bun.spawnSync(["which", "nowplaying-cli"]).exitCode === 0
}
