import { describe, expect, test } from "bun:test"
import { trackKey } from "@naxodev/music-core"
import {
  artworkDataForIdentity,
  artworkIdentityKey,
  createSystemMedia,
} from "../system-media.ts"

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

describe("system-media facade subscriptions", () => {
  test("forwards media-control invalidations and preserves the core disposer", () => {
    const stream = { listener: null as ((line: string) => void) | null }
    let streamDisposals = 0
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async () => ({ ok: true, out: "" }),
      startLineStream: (_command, callbacks) => {
        stream.listener = callbacks.onLine
        return () => {
          streamDisposals++
        }
      },
      setRetryTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearRetryTimer: () => {},
    })
    const changes: number[] = []

    const dispose = backend.subscribe?.(() => changes.push(1))
    expect(dispose).toBeDefined()
    stream.listener?.('{"type":"data","diff":false,"payload":{"title":"Song"}}')
    stream.listener?.("not json")
    expect(changes).toEqual([1])

    dispose?.()
    dispose?.()
    expect(streamDisposals).toBe(1)
  })

  test("omits subscriptions for nowplaying-cli", () => {
    const backend = createSystemMedia({
      detectBackend: () => "nowplaying-cli",
      hasNowPlayingCli: () => true,
      run: async () => ({ ok: true, out: "" }),
    })

    expect(backend.subscribe).toBeUndefined()
  })
})
