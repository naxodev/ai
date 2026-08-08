import { describe, expect, test } from "bun:test"
import {
  artworkDataForIdentity,
  artworkIdentityKey,
  bundleLabel,
  liveFromClock,
  trackKey,
} from "../system-media.ts"

describe("system media normalization", () => {
  test("uses stable metadata when the provider has no content identifier", () => {
    expect(trackKey("Song", "Artist", "")).toBe("Song\0Artist")
    expect(trackKey("Song", "Artist", "provider-id")).toBe("provider-id")
  })

  test.each([
    ["com.Spotify.client", "Spotify"],
    ["com.apple.Music", "Apple Music"],
    ["com.google.Chrome", "Chrome"],
    [null, "System media"],
  ])("labels %s as %s", (bundle, expected) => {
    expect(bundleLabel(bundle)).toBe(expected)
  })
})

describe("playback clock", () => {
  const clock = {
    trackKey: "song",
    anchor_ms: 5_000,
    wall_ms: 10_000,
    playing: true,
  }

  test("advances while playing and clamps to the track duration", () => {
    expect(liveFromClock(clock, 12_000, 20_000)).toBe(7_000)
    expect(liveFromClock(clock, 40_000, 20_000)).toBe(20_000)
  })

  test("holds progress while paused", () => {
    expect(liveFromClock({ ...clock, playing: false }, 20_000, 20_000)).toBe(
      5_000,
    )
  })
})

describe("artwork identity", () => {
  const identity = {
    uid: "provider-id",
    title: "Song",
    artist: "Artist",
    album: "Original",
    duration_ms: 180_000,
  }

  test("separates covers without changing the playback clock key", () => {
    expect(trackKey(identity.title, identity.artist, identity.uid)).toBe(
      "provider-id",
    )
    for (const changed of [
      { uid: "other-id" },
      { title: "Song (Remastered)" },
      { artist: "Another Artist" },
      { album: "Deluxe" },
      { duration_ms: 181_000 },
    ]) {
      expect(artworkIdentityKey({ ...identity, ...changed })).not.toBe(
        artworkIdentityKey(identity),
      )
    }
  })

  test("rejects native artwork if playback changed during the second sample", () => {
    const matchingSample = {
      contentItemIdentifier: identity.uid,
      title: identity.title,
      artist: identity.artist,
      album: identity.album,
      duration: identity.duration_ms / 1_000,
      artworkData: "new-track-cover",
    }
    for (const changed of [
      { contentItemIdentifier: "new-provider-id" },
      { title: "Next Song" },
      { artist: "Another Artist" },
      { album: "Next Album" },
      { duration: 200 },
    ]) {
      expect(
        artworkDataForIdentity(identity, { ...matchingSample, ...changed }),
      ).toBeNull()
    }
  })

  test("accepts native artwork only when the full second identity matches", () => {
    expect(
      artworkDataForIdentity(identity, {
        contentItemIdentifier: identity.uid,
        title: identity.title,
        artist: identity.artist,
        album: identity.album,
        duration: identity.duration_ms / 1_000,
        artworkData: "matching-cover",
      }),
    ).toBe("matching-cover")
  })
})
