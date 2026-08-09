export type Clock = {
  trackKey: string
  anchor_ms: number
  wall_ms: number
  playing: boolean
}

let clock: Clock | null = null

/** Clear module-level playback clock between tests or sessions. */
export function resetClock(): void {
  clock = null
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

/** Transport seam: play/pause updates the shared module clock. */
export function setClockPlaying(playing: boolean): void {
  const now = Date.now()
  if (!clock) {
    clock = { trackKey: "", anchor_ms: 0, wall_ms: now, playing }
    return
  }
  freezeClock(now)
  clock.playing = playing
}

/** Transport seam: seek re-anchors progress on the shared module clock. */
export function seekClock(positionMs: number): void {
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
}

export function trackKey(title: string, artist: string, uid: string): string {
  return uid || `${title}\0${artist}`
}

/**
 * Progress + play state.
 * Prefer the CLI's `playing` when present; otherwise fall back to rate + sticky clock.
 * Footer must show truthful progress/play state even when CLIs freeze elapsedTime.
 */
export function syncFromSample(opts: {
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
