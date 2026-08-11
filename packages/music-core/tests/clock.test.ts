import { describe, expect, test } from "bun:test"
import {
  createPlaybackClock,
  liveFromClock,
  trackKey,
  type Clock,
  type PlaybackClock,
} from "../clock.ts"

function sample(
  clock: PlaybackClock,
  opts: {
    key: string
    reported_ms: number
    reported?: boolean
    duration_ms: number
    playing: boolean | null
    rate: number
    now: number
  },
) {
  return clock.syncFromSample(opts)
}

describe("syncFromSample", () => {
  // Footer must show truthful progress when a track first appears.
  test("new track anchors the clock at reported progress while playing", () => {
    const clock = createPlaybackClock()
    const r = sample(clock, {
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
    const clock = createPlaybackClock()
    sample(clock, {
      key: "K",
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    // 2 s later; reported still within 400 ms of wall estimate (12_000 vs 12_000).
    const r = sample(clock, {
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
    const r2 = sample(clock, {
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
    const clock = createPlaybackClock()
    sample(clock, {
      key: "K",
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const paused = sample(clock, {
      key: "K",
      reported_ms: 15_000,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_005_000,
    })
    expect(paused.is_playing).toBe(false)
    expect(paused.progress_ms).toBe(15_000)

    const still = sample(clock, {
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
    const clock = createPlaybackClock()
    sample(clock, {
      key: "K",
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    sample(clock, {
      key: "K",
      reported_ms: 20_000,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_010_000,
    })
    const resumed = sample(clock, {
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
    const clock = createPlaybackClock()
    sample(clock, {
      key: "K",
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    // Wall +1 s → estimate 11_000; reported jumps to 20_000 (seek forward).
    const r = sample(clock, {
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
    const playingClock = createPlaybackClock()
    const playing = sample(playingClock, {
      key: "A",
      reported_ms: 5_000,
      duration_ms: 100_000,
      playing: null,
      rate: 1,
      now: 1_000_000,
    })
    expect(playing.is_playing).toBe(true)

    const pausedClock = createPlaybackClock()
    const paused = sample(pausedClock, {
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
    const clock = createPlaybackClock()
    sample(clock, {
      key: "old",
      reported_ms: 50_000,
      duration_ms: 200_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const next = sample(clock, {
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

  test("an explicit zero sample re-anchors a seek to track start", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: "same",
      reported_ms: 50_000,
      reported: true,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const sought = sample(clock, {
      key: "same",
      reported_ms: 0,
      reported: true,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_001_000,
    })

    expect(sought.progress_ms).toBe(0)
  })

  test("reused provider id with conflicting complete metadata resets the clock", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("Old Song", "Old Artist", "reused"),
      reported_ms: 50_000,
      duration_ms: 200_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const next = sample(clock, {
      key: trackKey("New Song", "New Artist", "reused"),
      reported_ms: 100,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_010_000,
    })
    expect(next.progress_ms).toBe(100)
  })

  test("provider metadata enrichment keeps the clock identity", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("Song", "", "stable"),
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const enriched = sample(clock, {
      key: trackKey("Song", "Artist", "stable"),
      reported_ms: 0,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_001_000,
    })
    expect(enriched.progress_ms).toBe(11_000)
  })

  test("metadata enrichment without a provider id preserves sticky pause", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("Song", "", ""),
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_000_000,
    })

    const enriched = sample(clock, {
      key: trackKey("Song", "Artist", ""),
      reported_ms: 0,
      duration_ms: 180_000,
      playing: null,
      rate: Number.NaN,
      now: 1_001_000,
    })
    const replacement = sample(clock, {
      key: trackKey("Other Song", "Artist", ""),
      reported_ms: 500,
      duration_ms: 120_000,
      playing: null,
      rate: Number.NaN,
      now: 1_002_000,
    })

    expect(enriched).toEqual({ progress_ms: 10_000, is_playing: false })
    expect(replacement).toEqual({ progress_ms: 500, is_playing: true })
  })

  test("a provider id can appear late or disappear without resetting a paused track", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("Song", "Artist", ""),
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_000_000,
    })
    const identified = sample(clock, {
      key: trackKey("Song", "Artist", "provider-id"),
      reported_ms: 0,
      duration_ms: 180_000,
      playing: null,
      rate: Number.NaN,
      now: 1_001_000,
    })
    const fallback = sample(clock, {
      key: trackKey("Song", "Artist", ""),
      reported_ms: 0,
      duration_ms: 180_000,
      playing: null,
      rate: Number.NaN,
      now: 1_002_000,
    })

    expect(identified).toEqual({ progress_ms: 10_000, is_playing: false })
    expect(fallback).toEqual({ progress_ms: 10_000, is_playing: false })
  })

  test("a volatile provider id does not reset complete matching metadata", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("Song", "Artist", "playing-id"),
      reported_ms: 0,
      reported: false,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const paused = sample(clock, {
      key: trackKey("Song", "Artist", "paused-id"),
      reported_ms: 0,
      reported: false,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_010_000,
    })
    const resumed = sample(clock, {
      key: trackKey("Song", "Artist", "resumed-id"),
      reported_ms: 0,
      reported: false,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_020_000,
    })

    expect(paused).toEqual({ progress_ms: 10_000, is_playing: false })
    expect(resumed).toEqual({ progress_ms: 10_000, is_playing: true })
  })

  test("a changed provider id and known duration resets an otherwise matching recording", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("Song", "Artist", "short-id"),
      reported_ms: 50_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const replacement = sample(clock, {
      key: trackKey("Song", "Artist", "long-id"),
      reported_ms: 100,
      duration_ms: 240_000,
      playing: true,
      rate: 1,
      now: 1_001_000,
    })

    expect(replacement.progress_ms).toBe(100)
  })

  test("a stable provider id cannot hide conflicting known durations", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("Song", "Artist", "stable-id"),
      reported_ms: 50_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const replacement = sample(clock, {
      key: trackKey("Song", "Artist", "stable-id"),
      reported_ms: 100,
      duration_ms: 240_000,
      playing: true,
      rate: 1,
      now: 1_001_000,
    })

    expect(replacement.progress_ms).toBe(100)
  })

  test("different provider ids do not match when either duration is unknown", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("Song", "Artist", "first-id"),
      reported_ms: 50_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    const replacement = sample(clock, {
      key: trackKey("Song", "Artist", "second-id"),
      reported_ms: 100,
      duration_ms: 0,
      playing: true,
      rate: 1,
      now: 1_001_000,
    })

    expect(replacement.progress_ms).toBe(100)
  })

  test("a sparse sample with the same provider id preserves the clock", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("Song", "Artist", "stable-id"),
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_000_000,
    })
    const sparse = sample(clock, {
      key: trackKey("", "", "stable-id"),
      reported_ms: 0,
      duration_ms: 0,
      playing: null,
      rate: Number.NaN,
      now: 1_001_000,
    })

    expect(sparse).toEqual({ progress_ms: 10_000, is_playing: false })
  })

  test("enrichment preserves sticky pause and makes a later reused-id replacement distinct", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("Song", "", "reused"),
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_000_000,
    })

    const enriched = sample(clock, {
      key: trackKey("Song", "Artist", "reused"),
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: null,
      rate: Number.NaN,
      now: 1_001_000,
    })
    expect(enriched).toEqual({ progress_ms: 10_000, is_playing: false })

    const replacement = sample(clock, {
      key: trackKey("Other Song", "Other Artist", "reused"),
      reported_ms: 500,
      duration_ms: 120_000,
      playing: null,
      rate: Number.NaN,
      now: 1_002_000,
    })
    expect(replacement).toEqual({ progress_ms: 500, is_playing: true })
  })

  test("partial enrichment records each known field before checking later conflicts", () => {
    const clock = createPlaybackClock()
    sample(clock, {
      key: trackKey("", "", "reused"),
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: false,
      rate: 0,
      now: 1_000_000,
    })
    const title = sample(clock, {
      key: trackKey("Old Song", "", "reused"),
      reported_ms: 0,
      duration_ms: 180_000,
      playing: null,
      rate: Number.NaN,
      now: 1_001_000,
    })
    const replacement = sample(clock, {
      key: trackKey("New Song", "Artist", "reused"),
      reported_ms: 500,
      duration_ms: 180_000,
      playing: null,
      rate: Number.NaN,
      now: 1_002_000,
    })

    expect(title).toEqual({ progress_ms: 10_000, is_playing: false })
    expect(replacement).toEqual({ progress_ms: 500, is_playing: true })
  })
})

describe("trackKey", () => {
  test("includes complete metadata with a provider id", () => {
    expect(trackKey("T", "A", "uid-1")).toBe("uid-1\0T\0A")
    expect(trackKey("T", "A", "")).toBe("T\0A")
  })
})

describe("transport clock seams", () => {
  test("injected play/pause time freezes and resumes the clock", () => {
    const clock = createPlaybackClock()
    clock.setPlaying(true, 1_000)
    clock.seek(500, 1_000)
    clock.setPlaying(false, 1_500)
    clock.setPlaying(true, 9_000)
    const state = sample(clock, {
      key: "",
      reported_ms: 0,
      duration_ms: 0,
      playing: null,
      rate: Number.NaN,
      now: 9_100,
    })
    expect(state.progress_ms).toBe(1_100)
  })

  test("injected seeks re-anchor forward and backward", () => {
    const clock = createPlaybackClock()
    clock.seek(5_000, 1_000)
    clock.seek(100, 2_000)
    const state = sample(clock, {
      key: "",
      reported_ms: 0,
      duration_ms: 0,
      playing: null,
      rate: Number.NaN,
      now: 2_200,
    })
    expect(state.progress_ms).toBe(300)
  })
})

describe("playback clock isolation", () => {
  // Two backends must not share progress or play state through a hidden singleton.
  test("two clocks keep independent tracks, play state, and transport mutations", () => {
    const left = createPlaybackClock()
    const right = createPlaybackClock()

    sample(left, {
      key: trackKey("Left Song", "Left Artist", "left-id"),
      reported_ms: 10_000,
      duration_ms: 180_000,
      playing: true,
      rate: 1,
      now: 1_000_000,
    })
    sample(right, {
      key: trackKey("Right Song", "Right Artist", "right-id"),
      reported_ms: 40_000,
      duration_ms: 240_000,
      playing: false,
      rate: 0,
      now: 1_000_000,
    })

    left.setPlaying(false, 1_001_000)
    right.setPlaying(true, 1_001_000)
    left.seek(2_000, 1_002_000)
    right.seek(55_000, 1_002_000)

    const leftAfter = sample(left, {
      key: trackKey("Left Song", "Left Artist", "left-id"),
      reported_ms: 0,
      reported: false,
      duration_ms: 180_000,
      playing: null,
      rate: Number.NaN,
      now: 1_002_500,
    })
    const rightAfter = sample(right, {
      key: trackKey("Right Song", "Right Artist", "right-id"),
      reported_ms: 0,
      reported: false,
      duration_ms: 240_000,
      playing: null,
      rate: Number.NaN,
      now: 1_002_500,
    })

    expect(leftAfter).toEqual({ progress_ms: 2_000, is_playing: false })
    expect(rightAfter).toEqual({ progress_ms: 55_500, is_playing: true })

    left.reset()
    const leftReset = sample(left, {
      key: trackKey("Fresh", "Artist", "fresh"),
      reported_ms: 100,
      duration_ms: 90_000,
      playing: true,
      rate: 1,
      now: 1_003_000,
    })
    const rightUnchanged = sample(right, {
      key: trackKey("Right Song", "Right Artist", "right-id"),
      reported_ms: 0,
      reported: false,
      duration_ms: 240_000,
      playing: null,
      rate: Number.NaN,
      now: 1_003_000,
    })

    expect(leftReset).toEqual({ progress_ms: 100, is_playing: true })
    expect(rightUnchanged).toEqual({ progress_ms: 56_000, is_playing: true })
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
