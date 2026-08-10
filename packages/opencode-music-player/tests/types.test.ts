import { describe, expect, test } from "bun:test"
import {
  emptyPlayer,
  formatMs,
  mergeArtworkCompletion,
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

test("artwork completion decorates only the matching recording", () => {
  const current = {
    ...emptyPlayer(),
    is_playing: true,
    progress_ms: 12_000,
    shuffle: true,
    repeat: "context" as const,
    track: {
      id: "new-provider-id",
      uri: "system:song",
      name: "Song",
      artists: "Artist",
      album: "Album",
      duration_ms: 0,
      artwork: null,
      artwork_loading: true,
    },
  }
  const event = {
    type: "artwork-completion" as const,
    identity: {
      uid: "old-provider-id",
      title: "Song",
      artist: "Artist",
      album: "Album",
      duration_ms: 180_000,
    },
    artwork: { id: "cover", png_base64: "png", accent: "blue", cells: [] },
    duration_ms: 180_000,
  }

  expect(mergeArtworkCompletion(current, event)).toMatchObject({
    is_playing: true,
    progress_ms: 12_000,
    shuffle: true,
    repeat: "context",
    track: {
      artwork: event.artwork,
      artwork_loading: false,
      duration_ms: 180_000,
    },
  })
  const knownDuration = {
    ...current,
    track: { ...current.track, duration_ms: 180_000 },
  }
  for (const identity of [
    { ...event.identity, title: "Replacement" },
    { ...event.identity, artist: "Other" },
    { ...event.identity, album: "Other" },
    { ...event.identity, duration_ms: 200_000 },
  ]) {
    expect(mergeArtworkCompletion(knownDuration, { ...event, identity })).toBe(
      knownDuration,
    )
  }
  expect(
    mergeArtworkCompletion(
      { ...current, track: { ...current.track, duration_ms: 120_000 } },
      event,
    )?.track?.duration_ms,
  ).toBe(120_000)
})
