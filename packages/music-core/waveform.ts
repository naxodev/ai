/** Deterministic playback visualization levels; this does not analyse audio. */

const MAX_LEVEL_DELTA_SECONDS = 0.05
const JITTER_TOLERANCE_MS = 80
const CORRECTION_SLEW_MS_PER_SECOND = 300
const EXTERNAL_SEEK_THRESHOLD_MS = 2_000

function hashSeed(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Stable visualization seed that does not change when provider metadata enriches. */
export function waveformSeedKey(title: string, providerId?: string): string {
  return title.trim() || providerId?.trim() || "idle"
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function clampPhase(value: number, durationMs: number): number {
  const nonNegative = Math.max(0, value)
  return durationMs > 0 ? Math.min(durationMs, nonNegative) : nonNegative
}

function fract(value: number): number {
  return value - Math.floor(value)
}

function targets(n: number, phaseSeconds: number, seed: number): Float64Array {
  const output = new Float64Array(n)
  const bpm = 96 + (seed % 28)
  const beat = ((phaseSeconds * bpm) / 60) * Math.PI * 2
  const kick = Math.max(0, Math.sin(beat)) ** 10
  const pulse = 0.5 + 0.5 * Math.sin(beat * 2 + 0.3)

  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i / (n - 1)
    const shape = 0.55 + 0.45 * Math.exp(-x * 1.8)
    const wobble =
      0.55 * Math.sin(phaseSeconds * 1.6 + i * 0.48 + seed * 0.01) +
      0.3 * Math.sin(phaseSeconds * 2.9 + i * 0.9) +
      0.15 * Math.sin(phaseSeconds * 5.1 + i * 0.2)
    const grain = fract(
      Math.sin(i * 9.1 + Math.floor(phaseSeconds * 6) * 17.3 + seed) * 43758.5,
    )
    output[i] = clamp01(
      shape *
        (0.32 + 0.28 * kick + 0.22 * pulse + 0.18 * (0.5 + 0.5 * wobble)) *
        (0.82 + 0.18 * grain),
    )
  }

  const blur = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    blur[i] =
      (output[i - 1] ?? output[i]!) * 0.2 +
      output[i]! * 0.6 +
      (output[i + 1] ?? output[i]!) * 0.2
  }
  return blur
}

export type WaveFrame = {
  track_key: string
  bars: number
  progress_ms: number
  fetched_at: number
  is_playing: boolean
  duration_ms: number
  now_ms: number
  seek?: boolean
}

export type WaveEngine = {
  n: number
  levels: Float64Array
  seed: number
  track_key: string
  phase_ms: number
  last_ms: number | null
  sample_progress_ms: number | null
  sample_fetched_at: number | null
  correction_ms: number
  paused_stable: boolean
  was_playing: boolean
  paused_at_ms: number | null
}

/** Provider progress projected into the injected wall-clock domain. */
export function livePlaybackPosition(frame: WaveFrame): number {
  const projected = frame.is_playing
    ? frame.progress_ms + (frame.now_ms - frame.fetched_at)
    : frame.progress_ms
  return clampPhase(projected, frame.duration_ms)
}

/** Fresh engine for `bars` cells; each resolved track identity has a stable motion seed. */
export function createEngine(bars: number, trackKey: string): WaveEngine {
  return {
    n: bars,
    levels: new Float64Array(bars),
    seed: hashSeed(trackKey || "idle"),
    track_key: trackKey,
    phase_ms: 0,
    last_ms: null,
    sample_progress_ms: null,
    sample_fetched_at: null,
    correction_ms: 0,
    paused_stable: true,
    was_playing: false,
    paused_at_ms: null,
  }
}

function resetEngine(engine: WaveEngine, frame: WaveFrame): void {
  engine.n = frame.bars
  engine.levels = new Float64Array(frame.bars)
  engine.seed = hashSeed(frame.track_key || "idle")
  engine.track_key = frame.track_key
  engine.phase_ms = frame.is_playing
    ? livePlaybackPosition(frame)
    : clampPhase(frame.progress_ms, frame.duration_ms)
  engine.last_ms = frame.now_ms
  engine.sample_progress_ms = frame.progress_ms
  engine.sample_fetched_at = frame.fetched_at
  engine.correction_ms = 0
  engine.paused_stable = !frame.is_playing
  engine.was_playing = frame.is_playing
  engine.paused_at_ms = frame.is_playing ? null : frame.now_ms
}

function updateLevels(
  engine: WaveEngine,
  playing: boolean,
  levelDeltaSeconds: number,
): void {
  if (!playing) {
    for (let i = 0; i < engine.n; i++) {
      engine.levels[i] = Math.max(
        0,
        engine.levels[i]! * Math.exp(-levelDeltaSeconds * 5),
      )
    }
    engine.paused_stable = isFlat(engine)
    return
  }

  const target = targets(engine.n, engine.phase_ms / 1000, engine.seed)
  const attack = 1 - Math.exp(-levelDeltaSeconds * 18)
  const release = 1 - Math.exp(-levelDeltaSeconds * 5)
  for (let i = 0; i < engine.n; i++) {
    const current = engine.levels[i]!
    const wanted = target[i]!
    engine.levels[i] =
      current + (wanted - current) * (wanted > current ? attack : release)
  }
  engine.paused_stable = false
}

/** Advance the display phase once, then smooth generated levels towards it. */
export function stepEngine(engine: WaveEngine, frame: WaveFrame): void {
  if (
    engine.track_key !== frame.track_key ||
    engine.n !== frame.bars ||
    engine.last_ms === null
  ) {
    resetEngine(engine, frame)
    updateLevels(engine, frame.is_playing, 0.016)
    return
  }

  const wallElapsedMs = Math.max(0, frame.now_ms - engine.last_ms)
  let elapsedMs = wallElapsedMs
  const levelDeltaSeconds = Math.min(
    MAX_LEVEL_DELTA_SECONDS,
    wallElapsedMs / 1000,
  )
  engine.last_ms = frame.now_ms

  if (!frame.is_playing) {
    const wasPlaying = engine.was_playing
    if (wasPlaying) engine.paused_at_ms = frame.now_ms
    engine.was_playing = false
    if (
      frame.seek ||
      (!wasPlaying &&
        engine.sample_progress_ms !== frame.progress_ms &&
        engine.paused_at_ms !== null &&
        frame.fetched_at > engine.paused_at_ms)
    ) {
      engine.phase_ms = livePlaybackPosition(frame)
      engine.correction_ms = 0
      engine.sample_progress_ms = frame.progress_ms
      engine.sample_fetched_at = frame.fetched_at
    }
    updateLevels(engine, false, levelDeltaSeconds)
    return
  }

  // A fresh provider sample marks the resume point. Older samples cannot prove
  // any post-resume playback, so they advance neither phase nor correction.
  if (!engine.was_playing) {
    engine.was_playing = true
    elapsedMs =
      engine.paused_at_ms !== null && frame.fetched_at > engine.paused_at_ms
        ? Math.max(0, frame.now_ms - frame.fetched_at)
        : 0
    engine.phase_ms = clampPhase(engine.phase_ms + elapsedMs, frame.duration_ms)
    engine.paused_at_ms = null
  } else {
    engine.phase_ms = clampPhase(engine.phase_ms + elapsedMs, frame.duration_ms)
  }

  const changedSample =
    engine.sample_progress_ms !== frame.progress_ms ||
    engine.sample_fetched_at !== frame.fetched_at
  if (changedSample) {
    const target = livePlaybackPosition(frame)
    const error = target - engine.phase_ms
    engine.sample_progress_ms = frame.progress_ms
    engine.sample_fetched_at = frame.fetched_at
    if (Math.abs(error) > EXTERNAL_SEEK_THRESHOLD_MS) {
      engine.phase_ms = target
      engine.correction_ms = 0
    } else if (Math.abs(error) <= JITTER_TOLERANCE_MS) {
      // Jitter is retained but never applied on the sample frame.
      engine.correction_ms = error
    } else {
      // `error` is measured from the displayed phase, which already includes
      // unpaid debt. Replacing debt prevents consecutive polls from charging it twice.
      engine.correction_ms = error
    }
  }

  // A caller-known seek remains authoritative even when its provider anchor
  // matches the previous poll.
  if (frame.seek) {
    engine.phase_ms = livePlaybackPosition(frame)
    engine.correction_ms = 0
  }

  if (!changedSample && engine.correction_ms !== 0) {
    const payment = Math.min(
      Math.abs(engine.correction_ms),
      CORRECTION_SLEW_MS_PER_SECOND * (elapsedMs / 1000),
    )
    const signedPayment = Math.sign(engine.correction_ms) * payment
    engine.phase_ms = clampPhase(
      engine.phase_ms + signedPayment,
      frame.duration_ms,
    )
    engine.correction_ms -= signedPayment
  }

  updateLevels(engine, true, levelDeltaSeconds)
}

/** Shared paused baseline transformation. Hosts choose the glyph and color. */
export function displayLevel(
  level: number,
  index: number,
  playing: boolean,
): number {
  if (playing) return level
  return level > 0.02 ? level * 0.4 : index % 4 === 0 ? 0.12 : 0
}

/** True once paused levels have reached the stable baseline. */
export function isFlat(engine: WaveEngine, eps = 0.01): boolean {
  for (let i = 0; i < engine.n; i++) {
    if ((engine.levels[i] ?? 0) >= eps) return false
  }
  return true
}
