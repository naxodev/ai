import { beforeEach, describe, expect, test } from "bun:test"
import {
  liveFromClock,
  resetClock,
  syncFromSample,
  trackKey,
  type Clock,
} from "../clock.ts"

beforeEach(() => {
  resetClock()
})

describe("syncFromSample", () => {
  // Footer must show truthful progress when a track first appears.
  test("new track anchors the clock at reported progress while playing", () => {
    const r = syncFromSample({
      key: "K",
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    expect(r.progress_ms).toBe(10_000)
    expect(r.is_playing).toBe(true)
  })

  // Players that freeze elapsedTime still need wall-clock progress advance.
  test("playing advances between samples without snap-back", () => {
    syncFromSample({
      key: "K",
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    // 2 s later; reported still within 400 ms of wall estimate (12_000 vs 12_000).
    const r = syncFromSample({
      key: "K",
      reported_ms: 12_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_002_000,
    })
    expect(r.progress_ms).toBe(12_000)
    expect(r.is_playing).toBe(true)

    // Frozen reported elapsed while wall advances — no snap-back to stale value.
    const r2 = syncFromSample({
      key: "K",
      reported_ms: 12_000, // frozen CLI
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_002_200, // +200 ms wall; delta = 12_000 - 12_200 = -200 < 400
    })
    expect(r2.progress_ms).toBe(12_200)
  })

  // Paused footer must not keep ticking the waveform progress.
  test("pause freezes progress across later paused samples", () => {
    syncFromSample({
      key: "K",
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const paused = syncFromSample({
      key: "K",
      reported_ms: 15_000,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_005_000,
    })
    expect(paused.is_playing).toBe(false)
    expect(paused.progress_ms).toBe(15_000)

    const still = syncFromSample({
      key: "K",
      reported_ms: 15_000,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_010_000, // +5 s still paused
    })
    expect(still.progress_ms).toBe(15_000)
    expect(still.is_playing).toBe(false)
  })

  // Resume must re-anchor so progress matches the player's reported position.
  test("resume re-anchors from reported position", () => {
    syncFromSample({
      key: "K",
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    syncFromSample({
      key: "K",
      reported_ms: 20_000,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_010_000,
    })
    const resumed = syncFromSample({
      key: "K",
      reported_ms: 25_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_020_000,
    })
    expect(resumed.is_playing).toBe(true)
    expect(resumed.progress_ms).toBe(25_000)
  })

  // Seek detection: large drift must snap so footer doesn't lag behind reality.
  test("drift >= 400 ms resyncs to reported value", () => {
    syncFromSample({
      key: "K",
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    // Wall +1 s → estimate 11_000; reported jumps to 20_000 (seek forward).
    const r = syncFromSample({
      key: "K",
      reported_ms: 20_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_001_000,
    })
    expect(r.progress_ms).toBe(20_000)
  })

  // nowplaying-cli often omits playing; rate must drive waveform animate/stop.
  test("missing playing falls back to rate", () => {
    const playing = syncFromSample({
      key: "A",
      reported_ms: 5_000,
      duration_ms: 100_000,
      playing: null,
      rate: 1,
      now: 1_000_000,
    })
    expect(playing.is_playing).toBe(true)

    resetClock()
    const paused = syncFromSample({
      key: "B",
      reported_ms: 5_000,
      duration_ms: 100_000,
      playing: null,
      rate: 0,
      now: 1_000_000,
    })
    expect(paused.is_playing).toBe(false)
  })

  // Track change must not carry previous progress into the new title's footer.
  test("track change resets clock from new sample", () => {
    syncFromSample({
      key: "old",
      reported_ms: 50_000,
      duration_ms: 200_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const next = syncFromSample({
      key: "new",
      reported_ms: 1_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_010_000,
    })
    expect(next.progress_ms).toBe(1_000)
    expect(next.is_playing).toBe(true)
  })
})

describe("trackKey", () => {
  test("prefers uid when present else title+artist", () => {
    expect(trackKey("T", "A", "uid-1")).toBe("uid-1")
    expect(trackKey("T", "A", "")).toBe("T\0A")
  })
})

describe("liveFromClock", () => {
  const clock: Clock = {
    trackKey: "song",
    anchor_ms: 5_000,
    wall_ms: 10_000,
    playing: true,
  }

  // UI progress bar must advance with wall time and never exceed duration.
  test("advances while playing and clamps to the track duration", () => {
    expect(liveFromClock(clock, 12_000, 20_000)).toBe(7_000)
    expect(liveFromClock(clock, 40_000, 20_000)).toBe(20_000)
  })

  // Paused UI must hold the last anchor, not keep ticking.
  test("holds progress while paused", () => {
    expect(liveFromClock({ ...clock, playing: false }, 20_000, 20_000)).toBe(
      5_000,
    )
  })
})
