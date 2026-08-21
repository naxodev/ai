export type Clock = {
  trackKey: string
  anchor_ms: number
  wall_ms: number
  playing: boolean
}

export type SampleSyncInput = {
  key: string
  reported_ms: number
  reported?: boolean
  duration_ms: number
  playing: boolean | null
  rate: number
  now: number
}

export type SampleSyncResult = {
  progress_ms: number
  is_playing: boolean
}

/**
 * Backend-owned playback clock. Each `createSystemMedia()` result holds one
 * instance so sampling and transport mutations never share hidden module state.
 */
export type PlaybackClock = {
  syncFromSample: (opts: SampleSyncInput) => SampleSyncResult
  reset: () => void
  setPlaying: (playing: boolean, now?: number) => void
  seek: (positionMs: number, now?: number) => void
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

export function trackKey(title: string, artist: string, uid: string): string {
  // Keep provider IDs and metadata together: IDs can be reused by a provider.
  return uid ? `${uid}\0${title}\0${artist}` : `${title}\0${artist}`
}

function sameTrackKeyIdentity(
  left: string,
  right: string,
  leftDurationMs: number,
  rightDurationMs: number,
  allowSparseVolatileId: boolean,
): boolean {
  const leftParts = left.split("\0")
  const rightParts = right.split("\0")
  if (
    (leftParts.length !== 2 && leftParts.length !== 3) ||
    (rightParts.length !== 2 && rightParts.length !== 3)
  )
    return left === right

  const [leftId, leftTitle, leftArtist] =
    leftParts.length === 3 ? leftParts : ["", ...leftParts]
  const [rightId, rightTitle, rightArtist] =
    rightParts.length === 3 ? rightParts : ["", ...rightParts]
  if (leftTitle && rightTitle && leftTitle !== rightTitle) return false
  if (leftArtist && rightArtist && leftArtist !== rightArtist) return false
  const leftDurationKnown = leftDurationMs > 0
  const rightDurationKnown = rightDurationMs > 0
  if (
    leftDurationKnown &&
    rightDurationKnown &&
    Math.abs(leftDurationMs - rightDurationMs) > 1_000
  ) {
    return false
  }
  if (
    leftTitle &&
    rightTitle &&
    leftArtist &&
    rightArtist &&
    leftTitle === rightTitle &&
    leftArtist === rightArtist
  ) {
    if (leftId && rightId && leftId !== rightId) {
      return (leftDurationKnown && rightDurationKnown) || allowSparseVolatileId
    }
    return true
  }
  if (leftId && rightId && leftId !== rightId) return false
  return true
}

function enrichTrackKey(current: string, sample: string): string {
  const currentParts = current.split("\0")
  const sampleParts = sample.split("\0")
  if (
    (currentParts.length !== 2 && currentParts.length !== 3) ||
    (sampleParts.length !== 2 && sampleParts.length !== 3)
  ) {
    return current
  }
  const [currentId, currentTitle, currentArtist] =
    currentParts.length === 3 ? currentParts : ["", ...currentParts]
  const [sampleId, sampleTitle, sampleArtist] =
    sampleParts.length === 3 ? sampleParts : ["", ...sampleParts]
  return trackKey(
    currentTitle || sampleTitle || "",
    currentArtist || sampleArtist || "",
    currentId || sampleId || "",
  )
}

/** Create an independent playback clock for one backend or test fixture. */
export function createPlaybackClock(): PlaybackClock {
  let clock: Clock | null = null
  let clockDurationMs = 0

  const freezeClock = (now: number) => {
    if (!clock) return
    clock.anchor_ms = liveFromClock(clock, now, 0)
    clock.wall_ms = now
  }

  return {
    reset() {
      clock = null
      clockDurationMs = 0
    },

    setPlaying(playing: boolean, now = Date.now()) {
      if (!clock) {
        clock = { trackKey: "", anchor_ms: 0, wall_ms: now, playing }
        return
      }
      freezeClock(now)
      clock.playing = playing
    },

    seek(positionMs: number, now = Date.now()) {
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
    },

    /**
     * Progress + play state.
     * Prefer the CLI's `playing` when present; otherwise fall back to rate + sticky clock.
     * Footer must show truthful progress/play state even when CLIs freeze elapsedTime.
     */
    syncFromSample(opts: SampleSyncInput): SampleSyncResult {
      const { key, reported_ms, duration_ms, now } = opts
      const hasReported = opts.reported ?? reported_ms > 0
      const matchesClock = clock
        ? sameTrackKeyIdentity(
            clock.trackKey,
            key,
            clockDurationMs,
            duration_ms,
            !hasReported,
          )
        : false

      let isPlaying: boolean
      if (opts.playing === true || opts.playing === false) {
        isPlaying = opts.playing
      } else if (Number.isFinite(opts.rate)) {
        isPlaying = opts.rate > 0.01
      } else {
        isPlaying = matchesClock && clock ? clock.playing : true
      }

      if (!clock || !matchesClock) {
        clock = {
          trackKey: key,
          anchor_ms: hasReported ? reported_ms : 0,
          wall_ms: now,
          playing: isPlaying,
        }
        clockDurationMs = duration_ms
        return {
          progress_ms: liveFromClock(clock, now, duration_ms),
          is_playing: isPlaying,
        }
      }

      clock.trackKey = enrichTrackKey(clock.trackKey, key)
      if (duration_ms > 0) clockDurationMs = duration_ms

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
    },
  }
}

const legacyClock = createPlaybackClock()

/** @deprecated Create an independent clock with `createPlaybackClock()` instead. */
export function syncFromSample(opts: SampleSyncInput): SampleSyncResult {
  return legacyClock.syncFromSample(opts)
}

/** @deprecated Reset the independent clock owned by your backend instead. */
export function resetClock(): void {
  legacyClock.reset()
}

/** @deprecated Update the independent clock owned by your backend instead. */
export function setClockPlaying(playing: boolean, now = Date.now()): void {
  legacyClock.setPlaying(playing, now)
}

/** @deprecated Seek the independent clock owned by your backend instead. */
export function seekClock(positionMs: number, now = Date.now()): void {
  legacyClock.seek(positionMs, now)
}
