import { describe, expect, test } from "bun:test"
import { mergePlayer } from "../reconcile.ts"
import type { PlayerState, Track } from "../types.ts"

function track(partial: Partial<Track> & Pick<Track, "id" | "name">): Track {
  return {
    uri: `system:now:${partial.name}`,
    artists: "Artist",
    album: "Album",
    duration_ms: 180_000,
    ...partial,
  }
}

function player(
  partial: Partial<PlayerState> & {
    track: Track | null
    progress_ms: number
    is_playing: boolean
    fetched_at: number
  },
): PlayerState {
  return {
    shuffle: false,
    repeat: "off",
    device: null,
    ...partial,
  }
}

describe("mergePlayer", () => {
  // Null poll must clear state; incomplete track identity falls through to next.
  test("null next returns null; missing track on either side accepts next", () => {
    expect(mergePlayer(null, null)).toBeNull()

    const next = player({
      track: track({ id: "1", name: "Song" }),
      progress_ms: 1_000,
      is_playing: true,
      fetched_at: 1_000_000,
    })
    expect(mergePlayer(null, next)).toBe(next)

    const prevNoTrack = player({
      track: null,
      progress_ms: 5_000,
      is_playing: true,
      fetched_at: 1_000_000,
    })
    expect(mergePlayer(prevNoTrack, next)).toBe(next)
  })

  // Track change must accept the new sample instead of blending identities.
  test("different id and name accepts next as a track change", () => {
    const prev = player({
      track: track({ id: "old", name: "Old Song" }),
      progress_ms: 50_000,
      is_playing: true,
      fetched_at: Date.now() - 1_000,
    })
    const next = player({
      track: track({ id: "new", name: "New Song" }),
      progress_ms: 100,
      is_playing: true,
      fetched_at: Date.now(),
    })
    expect(mergePlayer(prev, next)).toBe(next)
  })

  // Poll glitches that report ~0 while still playing must not rewind the bar.
  test("same track sudden drop to ~0 keeps monotonic prevLive clamped to duration", () => {
    const now = Date.now()
    const prev = player({
      track: track({ id: "same", name: "Same", duration_ms: 180_000 }),
      progress_ms: 30_000,
      is_playing: true,
      fetched_at: now - 500,
    })
    const next = player({
      track: track({ id: "same", name: "Same", duration_ms: 180_000 }),
      progress_ms: 0,
      is_playing: true,
      fetched_at: now,
    })
    const merged = mergePlayer(prev, next)
    expect(merged).not.toBeNull()
    expect(merged!.progress_ms).toBeGreaterThan(30_000)
    expect(merged!.progress_ms).toBeLessThanOrEqual(180_000)
    expect(merged!.is_playing).toBe(true)
    expect(merged!.fetched_at).toBeGreaterThanOrEqual(now)
  })

  // Normal small progress updates must pass through unchanged.
  test("same track normal progress update accepts next", () => {
    const now = Date.now()
    const prev = player({
      track: track({ id: "same", name: "Same" }),
      progress_ms: 10_000,
      is_playing: true,
      fetched_at: now - 1_000,
    })
    const next = player({
      track: track({ id: "same", name: "Same" }),
      progress_ms: 11_000,
      is_playing: true,
      fetched_at: now,
    })
    expect(mergePlayer(prev, next)).toBe(next)
  })

  // Guard only fires for playing samples with a sudden drop; paused next wins as-is.
  test("paused next is accepted without inventing play state", () => {
    const now = Date.now()
    const prev = player({
      track: track({ id: "same", name: "Same" }),
      progress_ms: 30_000,
      is_playing: true,
      fetched_at: now - 500,
    })
    const next = player({
      track: track({ id: "same", name: "Same" }),
      progress_ms: 100,
      is_playing: false,
      fetched_at: now,
    })
    expect(mergePlayer(prev, next)).toBe(next)
    expect(mergePlayer(prev, next)!.is_playing).toBe(false)
  })

  // Hosts attach presentation data to tracks; the rewind guard must retain it.
  test("same-track guard retains host-enriched track data", () => {
    type ArtworkPlayer = Omit<PlayerState, "track"> & {
      track: (Track & { artwork: string }) | null
    }
    const now = Date.now()
    const prev: ArtworkPlayer = {
      ...player({
        track: track({ id: "same", name: "Same" }),
        progress_ms: 30_000,
        is_playing: true,
        fetched_at: now - 500,
      }),
      track: { ...track({ id: "same", name: "Same" }), artwork: "old-cover" },
    }
    const next: ArtworkPlayer = {
      ...player({
        track: track({ id: "same", name: "Same" }),
        progress_ms: 0,
        is_playing: true,
        fetched_at: now,
      }),
      track: { ...track({ id: "same", name: "Same" }), artwork: "new-cover" },
    }

    const merged = mergePlayer(prev, next)
    expect(merged).not.toBeNull()
    expect(merged!.track!.artwork).toBe("new-cover")
    expect(merged!.progress_ms).toBeGreaterThan(30_000)
  })
})
