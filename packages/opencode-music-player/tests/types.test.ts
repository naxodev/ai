import { describe, expect, test } from "bun:test"
import {
  emptyPlayer,
  formatMs,
  mergePlayerPresentation,
  type PlayerState,
} from "../types.ts"

describe("formatMs", () => {
  test.each([
    [-1, "0:00"],
    [999, "0:00"],
    [61_999, "1:01"],
    [3_600_000, "60:00"],
  ])("formats %d milliseconds as %s", (milliseconds, expected) => {
    expect(formatMs(milliseconds)).toBe(expected)
  })
})

test("emptyPlayer returns independent timestamps", () => {
  const before = Date.now()
  const player = emptyPlayer()

  expect(player).toMatchObject({
    is_playing: false,
    progress_ms: 0,
    device: null,
    track: null,
  })
  expect(player.fetched_at).toBeGreaterThanOrEqual(before)
})

test("same-track pause samples retain progress and artwork presentation", () => {
  const artwork = {
    id: "cover",
    png_base64: "png",
    accent: "blue",
    cells: [],
  }
  const previous: PlayerState = {
    ...emptyPlayer(),
    is_playing: true,
    progress_ms: 40_000,
    track: {
      id: "song",
      uri: "system:song",
      name: "Song",
      artists: "Artist",
      album: "Album",
      duration_ms: 180_000,
      artwork,
    },
  }
  const paused: PlayerState = {
    ...previous,
    is_playing: false,
    track: { ...previous.track!, duration_ms: 0, artwork: null },
  }

  expect(mergePlayerPresentation(previous, paused)?.track).toMatchObject({
    duration_ms: 180_000,
    artwork,
  })
})

test("volatile provider ids do not discard matching artwork metadata", () => {
  const previous: PlayerState = {
    ...emptyPlayer(),
    track: {
      id: "playing-id",
      uri: "system:song",
      name: "Song",
      artists: "Artist",
      album: "Album",
      duration_ms: 180_000,
      artwork: {
        id: "cover",
        png_base64: "png",
        accent: "blue",
        cells: [],
      },
    },
  }
  const paused: PlayerState = {
    ...previous,
    is_playing: false,
    track: { ...previous.track!, id: "paused-id", artwork: null },
  }

  expect(mergePlayerPresentation(previous, paused)?.track?.artwork?.id).toBe(
    "cover",
  )

  const incomplete = {
    ...paused,
    track: { ...paused.track!, album: "", duration_ms: 0 },
  }
  expect(
    mergePlayerPresentation(previous, incomplete)?.track?.artwork?.id,
  ).toBe("cover")

  const replacementAlbum = {
    ...paused,
    track: { ...paused.track!, album: "Deluxe" },
  }
  expect(
    mergePlayerPresentation(previous, replacementAlbum)?.track?.artwork,
  ).toBeNull()

  const replacementDuration = {
    ...paused,
    track: { ...paused.track!, duration_ms: 200_000 },
  }
  expect(
    mergePlayerPresentation(previous, replacementDuration)?.track?.artwork,
  ).toBeNull()
})
