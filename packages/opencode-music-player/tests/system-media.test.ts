import { describe, expect, test } from "bun:test"
import {
  artworkDataForIdentity,
  artworkIdentityKey,
  bundleLabel,
  createSystemMedia,
  liveFromClock,
  run,
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

describe("media command boundaries", () => {
  test("a wedged provider releases polling so a later sample can refresh the sidebar", async () => {
    const result = await run(
      [process.execPath, "-e", "await Bun.sleep(1_000)"],
      50,
    )

    expect(result).toEqual({
      ok: false,
      err: "command timed out after 50ms",
      timed_out: true,
    })
  })

  test("keeps the current track visible through the fallback when the preferred provider times out", async () => {
    const providers: string[] = []
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => true,
      run: async ([provider]) => {
        providers.push(provider!)
        if (provider === "media-control") {
          return { ok: false, err: "command timed out", timed_out: true }
        }
        return {
          ok: true,
          out: JSON.stringify({
            title: "Fallback Song",
            artist: "Fallback Artist",
            album: "",
            duration: 180,
            elapsedTime: 30,
            playbackRate: 1,
            isPlaying: true,
          }),
        }
      },
    })

    const player = await backend.player()

    expect(providers).toEqual(["media-control", "nowplaying-cli"])
    expect(player?.track?.name).toBe("Fallback Song")
    expect(player?.is_playing).toBe(true)
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
