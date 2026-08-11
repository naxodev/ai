import { expect, test } from "bun:test"
import {
  createSystemMedia,
  resetClock,
  seekClock,
  setClockPlaying,
  syncFromSample,
  trackKey,
} from "../index.ts"

test("legacy clock exports retain their behavior without affecting backend clocks", async () => {
  resetClock()
  const key = trackKey("Legacy", "Caller", "legacy-id")
  syncFromSample({
    key,
    reported_ms: 10_000,
    duration_ms: 180_000,
    playing: false,
    rate: 0,
    now: 1_000_000,
  })
  seekClock(20_000, 1_001_000)
  setClockPlaying(false, 1_001_000)

  const backend = createSystemMedia({
    detectBackend: () => "media-control",
    hasNowPlayingCli: () => false,
    run: async () => ({
      ok: true,
      out: JSON.stringify({
        contentItemIdentifier: "backend-id",
        title: "Backend",
        artist: "Player",
        album: "Album",
        duration: 240,
        elapsedTimeNow: 40,
        playing: true,
        bundleIdentifier: "com.apple.Music",
      }),
    }),
    now: () => 1_002_000,
  })

  expect(await backend.player()).toMatchObject({
    is_playing: true,
    progress_ms: 40_000,
  })
  expect(
    syncFromSample({
      key,
      reported_ms: 0,
      reported: false,
      duration_ms: 180_000,
      playing: null,
      rate: Number.NaN,
      now: 1_003_000,
    }),
  ).toEqual({ progress_ms: 20_000, is_playing: false })
})
