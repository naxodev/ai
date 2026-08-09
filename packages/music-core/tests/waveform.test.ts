import { describe, expect, test } from "bun:test"
import {
  createEngine,
  isFlat,
  stepEngine,
  type WaveEngine,
} from "../waveform.ts"

/** Advance the engine `steps` times at 50 ms per step (dt cap in stepEngine is 0.05 s). Continues from eng.lastMs so multi-phase drives keep monotonic wall time. */
function drive(
  eng: WaveEngine,
  opts: { steps: number; playing: boolean; startMs?: number },
): number {
  let now = opts.startMs ?? eng.lastMs ?? 0
  // tMs tracks animation phase; keep it aligned with wall when continuing.
  let tMs = now
  for (let i = 0; i < opts.steps; i++) {
    tMs += 50
    now += 50
    stepEngine(eng, tMs, opts.playing, now)
  }
  return tMs
}

function levelsEqual(a: WaveEngine, b: WaveEngine): boolean {
  if (a.n !== b.n) return false
  for (let i = 0; i < a.n; i++) {
    if (a.levels[i] !== b.levels[i]) return false
  }
  return true
}

describe("stepEngine / isFlat", () => {
  // Paused waveform must stop — levels decay below eps within ~1 s simulated.
  test("paused decay goes flat within ~1.2 s simulated time", () => {
    const eng = createEngine(16, "decay")
    drive(eng, { steps: 30, playing: true })
    // Confirm energy is present before pause.
    expect(isFlat(eng)).toBe(false)
    let max = 0
    for (let i = 0; i < eng.n; i++) max = Math.max(max, eng.levels[i] ?? 0)
    expect(max).toBeGreaterThan(0.1)

    drive(eng, { steps: 24, playing: false }) // 1.2 s
    expect(isFlat(eng)).toBe(true)
    for (let i = 0; i < eng.n; i++) {
      expect(eng.levels[i] ?? 0).toBeLessThan(0.01)
    }
  })

  // Hosts rely on isFlat to stop/start the animation timer.
  test("flat detection: fresh engine true, after playing step false", () => {
    const eng = createEngine(16, "flat-detect")
    expect(isFlat(eng)).toBe(true)
    stepEngine(eng, 50, true, 50)
    expect(isFlat(eng)).toBe(false)
  })
})

describe("determinism", () => {
  // Stable tests and stable host rendering require identical drive → identical levels.
  test("same seed + same drive yields identical levels; different seed differs", () => {
    const a = createEngine(16, "same-track")
    const b = createEngine(16, "same-track")
    const c = createEngine(16, "other-track")

    const seq: { tMs: number; playing: boolean; now: number }[] = []
    let t = 0
    for (let i = 0; i < 20; i++) {
      t += 50
      seq.push({ tMs: t, playing: true, now: t })
    }

    for (const s of seq) {
      stepEngine(a, s.tMs, s.playing, s.now)
      stepEngine(b, s.tMs, s.playing, s.now)
      stepEngine(c, s.tMs, s.playing, s.now)
    }

    expect(a.seed).toBe(b.seed)
    expect(a.seed).not.toBe(c.seed)
    expect(levelsEqual(a, b)).toBe(true)
    expect(levelsEqual(a, c)).toBe(false)
  })
})
