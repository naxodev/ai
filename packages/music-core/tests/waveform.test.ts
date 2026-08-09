import { describe, expect, test } from "bun:test"
import {
  createEngine,
  isFlat,
  livePlaybackPosition,
  stepEngine,
  waveformSeedKey,
  type WaveEngine,
  type WaveFrame,
} from "../waveform.ts"

test("waveform seed ignores metadata that can arrive later", () => {
  expect(waveformSeedKey("Song", "provider-id")).toBe("Song")
  expect(waveformSeedKey("Song", "")).toBe(
    waveformSeedKey("Song", "provider-id"),
  )
  expect(waveformSeedKey("Song")).toBe("Song")
})

function frame(overrides: Partial<WaveFrame> = {}): WaveFrame {
  return {
    track_key: "track-a",
    bars: 16,
    progress_ms: 1_000,
    fetched_at: 10_000,
    is_playing: true,
    duration_ms: 180_000,
    now_ms: 10_000,
    ...overrides,
  }
}

function levelsEqual(left: WaveEngine, right: WaveEngine): boolean {
  return left.levels.every((level, index) => level === right.levels[index])
}

describe("livePlaybackPosition", () => {
  test("returns sampled progress while paused instead of inventing wall-clock playback", () => {
    expect(
      livePlaybackPosition(
        frame({
          progress_ms: 4_000,
          fetched_at: 10_000,
          now_ms: 25_000,
          is_playing: false,
        }),
      ),
    ).toBe(4_000)
  })
})

describe("stepEngine", () => {
  test("anchors initial play and advances elapsed playback time once", () => {
    const engine = createEngine(16, "")
    stepEngine(engine, frame())
    expect(engine.phase_ms).toBe(1_000)
    stepEngine(engine, frame({ now_ms: 10_100 }))
    expect(engine.phase_ms).toBe(1_100)
    stepEngine(engine, frame({ now_ms: 10_200 }))
    expect(engine.phase_ms).toBe(1_200)
  })

  test("does not repeatedly apply one provider sample", () => {
    const engine = createEngine(16, "")
    stepEngine(engine, frame({ progress_ms: 5_000 }))
    stepEngine(engine, frame({ progress_ms: 5_000, now_ms: 10_100 }))
    stepEngine(engine, frame({ progress_ms: 5_000, now_ms: 10_200 }))
    expect(engine.phase_ms).toBe(5_200)
  })

  test("jitter and ordinary corrections do not jump on their sample frame and slew both directions", () => {
    for (const correction of [79, 80, 81, 500, -500]) {
      const engine = createEngine(16, "")
      stepEngine(engine, frame({ progress_ms: 1_000 }))
      stepEngine(
        engine,
        frame({
          progress_ms: 1_100 + correction,
          fetched_at: 10_100,
          now_ms: 10_100,
        }),
      )
      expect(engine.phase_ms).toBe(1_100)
      expect(Math.sign(engine.correction_ms)).toBe(Math.sign(correction))
      for (
        let now = 10_200;
        now <= 14_000 && engine.correction_ms !== 0;
        now += 100
      ) {
        stepEngine(
          engine,
          frame({
            progress_ms: 1_100 + correction,
            fetched_at: 10_100,
            now_ms: now,
          }),
        )
      }
      expect(engine.correction_ms).toBe(0)
    }
  })

  test("consecutive corrections replace unpaid debt instead of counting it twice", () => {
    const engine = createEngine(16, "")
    stepEngine(engine, frame())
    stepEngine(
      engine,
      frame({ progress_ms: 1_600, fetched_at: 10_100, now_ms: 10_100 }),
    )
    expect(engine.correction_ms).toBe(500)
    stepEngine(
      engine,
      frame({ progress_ms: 1_700, fetched_at: 10_200, now_ms: 10_200 }),
    )
    // The new target is 500 ms ahead of the displayed phase, not 1,000 ms ahead.
    expect(engine.correction_ms).toBe(500)
    stepEngine(
      engine,
      frame({ progress_ms: 1_700, fetched_at: 10_200, now_ms: 10_300 }),
    )
    expect(engine.phase_ms).toBe(1_330)
    expect(engine.correction_ms).toBe(470)
  })

  test("explicit and external seeks re-anchor immediately", () => {
    const engine = createEngine(16, "")
    stepEngine(engine, frame())
    stepEngine(
      engine,
      frame({
        progress_ms: 9_000,
        fetched_at: 10_100,
        now_ms: 10_100,
        seek: true,
      }),
    )
    expect(engine.phase_ms).toBe(9_000)
    stepEngine(
      engine,
      frame({
        progress_ms: 500,
        fetched_at: 10_200,
        now_ms: 10_200,
        seek: true,
      }),
    )
    expect(engine.phase_ms).toBe(500)
    stepEngine(
      engine,
      frame({ progress_ms: 8_000, fetched_at: 10_300, now_ms: 10_300 }),
    )
    expect(engine.phase_ms).toBe(8_000)

    stepEngine(engine, frame({ now_ms: 10_400, seek: true }))
    expect(engine.phase_ms).toBe(1_400)
  })

  test("paused forward and backward seeks use sampled positions without wall extrapolation", () => {
    const engine = createEngine(16, "")
    stepEngine(engine, frame({ progress_ms: 5_000 }))
    stepEngine(engine, frame({ is_playing: false, now_ms: 10_100 }))

    stepEngine(
      engine,
      frame({
        progress_ms: 12_000,
        fetched_at: 10_200,
        is_playing: false,
        now_ms: 20_000,
        seek: true,
      }),
    )
    expect(engine.phase_ms).toBe(12_000)

    stepEngine(
      engine,
      frame({
        progress_ms: 800,
        fetched_at: 20_100,
        is_playing: false,
        now_ms: 30_000,
        seek: true,
      }),
    )
    expect(engine.phase_ms).toBe(800)
  })

  test("paused provider progress changes are seeks even without a host hint", () => {
    const engine = createEngine(8, "track")
    stepEngine(engine, frame({ is_playing: false, progress_ms: 10_000 }))

    stepEngine(
      engine,
      frame({
        is_playing: false,
        progress_ms: 30_000,
        fetched_at: 10_100,
        now_ms: 20_000,
      }),
    )

    expect(engine.phase_ms).toBe(30_000)
    expect(engine.correction_ms).toBe(0)
  })

  test("external seek threshold re-anchors only above its boundary", () => {
    for (const correction of [1_999, 2_000]) {
      const engine = createEngine(16, "")
      stepEngine(engine, frame())
      stepEngine(
        engine,
        frame({
          progress_ms: 1_100 + correction,
          fetched_at: 10_100,
          now_ms: 10_100,
        }),
      )
      expect(engine.phase_ms).toBe(1_100)
    }
    const engine = createEngine(16, "")
    stepEngine(engine, frame())
    stepEngine(
      engine,
      frame({ progress_ms: 3_101, fetched_at: 10_100, now_ms: 10_100 }),
    )
    expect(engine.phase_ms).toBe(3_101)
  })

  test("seek keeps level smoothing active", () => {
    const engine = createEngine(16, "")
    stepEngine(engine, frame())
    const before = engine.levels.slice()
    stepEngine(
      engine,
      frame({
        progress_ms: 20_000,
        fetched_at: 10_100,
        now_ms: 10_100,
        seek: true,
      }),
    )
    // A re-anchor changes the target phase, but it does not assign target levels directly.
    expect(engine.levels.every((level) => level < 0.5)).toBe(true)
    expect(engine.levels.some((level, index) => level !== before[index])).toBe(
      true,
    )
  })

  test("pause freezes phase, settles, and resume excludes paused wall time", () => {
    const engine = createEngine(16, "")
    stepEngine(engine, frame())
    stepEngine(engine, frame({ now_ms: 10_100 }))
    const held = engine.phase_ms
    for (let now = 10_200; now <= 12_000; now += 100) {
      stepEngine(engine, frame({ is_playing: false, now_ms: now }))
      expect(engine.phase_ms).toBe(held)
    }
    expect(isFlat(engine)).toBe(true)
    stepEngine(engine, frame({ fetched_at: 19_900, now_ms: 20_000 }))
    expect(engine.phase_ms).toBe(held + 100)
    expect(isFlat(engine)).toBe(false)
  })

  test("does not pay correction debt accumulated before a pause on resume", () => {
    const engine = createEngine(16, "")
    stepEngine(engine, frame())
    stepEngine(
      engine,
      frame({ progress_ms: 1_600, fetched_at: 10_100, now_ms: 10_100 }),
    )
    expect(engine.correction_ms).toBe(500)
    stepEngine(engine, frame({ is_playing: false, now_ms: 10_200 }))
    stepEngine(engine, frame({ is_playing: false, now_ms: 20_000 }))
    const held = engine.phase_ms
    stepEngine(
      engine,
      frame({ progress_ms: 1_600, fetched_at: 10_100, now_ms: 20_000 }),
    )
    expect(engine.phase_ms).toBe(held)
    expect(engine.correction_ms).toBe(500)
  })

  test("clamps at duration and resets all timing state on a changed identity", () => {
    const engine = createEngine(16, "")
    stepEngine(engine, frame({ progress_ms: 990, duration_ms: 1_000 }))
    stepEngine(engine, frame({ now_ms: 10_100, duration_ms: 1_000 }))
    expect(engine.phase_ms).toBe(1_000)
    engine.correction_ms = 100
    stepEngine(
      engine,
      frame({ track_key: "track-b", progress_ms: 50, now_ms: 10_200 }),
    )
    expect(engine.phase_ms).toBe(250)
    expect(engine.correction_ms).toBe(0)
    expect(engine.levels.every((level) => level < 0.3)).toBe(true)
  })

  test("same input is deterministic and a different track has a different seed", () => {
    const left = createEngine(16, "track-a")
    const right = createEngine(16, "track-a")
    const other = createEngine(16, "track-b")
    for (let now = 10_000; now <= 11_000; now += 50) {
      const input = frame({ now_ms: now })
      stepEngine(left, input)
      stepEngine(right, input)
      stepEngine(other, { ...input, track_key: "track-b" })
    }
    expect(levelsEqual(left, right)).toBe(true)
    expect(levelsEqual(left, other)).toBe(false)
  })
})
