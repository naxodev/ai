import { describe, expect, test } from "bun:test"
import { trackKey } from "@naxodev/music-core"
import {
  artworkCacheKey,
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

  test("uses a narrower playback identity than the artwork identity", () => {
    expect(trackKey(identity.title, identity.artist, identity.uid)).toBe(
      "provider-id\0Song\0Artist",
    )
    expect(trackKey(identity.title, identity.artist, identity.uid)).not.toBe(
      trackKey("Song (Remastered)", identity.artist, identity.uid),
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

  test("reuses cached artwork when only the provider id changes", () => {
    expect(artworkCacheKey({ ...identity, uid: "paused-id" })).toBe(
      artworkCacheKey(identity),
    )
    expect(artworkCacheKey({ ...identity, album: "Deluxe" })).not.toBe(
      artworkCacheKey(identity),
    )
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

  test("preserves raw provider ids when validating native artwork", () => {
    expect(
      artworkDataForIdentity(
        { ...identity, uid: "provider-id\0Song\0Artist" },
        {
          contentItemIdentifier: "provider-id",
          title: identity.title,
          artist: identity.artist,
          album: identity.album,
          duration: identity.duration_ms / 1_000,
          artworkData: "cover",
        },
      ),
    ).toBeNull()
  })
})

describe("system-media facade subscriptions", () => {
  test("retries null artwork on its bounded schedule", async () => {
    let now = 10_000
    let resolutions = 0
    const completions: unknown[] = []
    const payload = {
      contentItemIdentifier: "playing-id",
      title: "Shared Artwork Song",
      artist: "Artist",
      album: "Album",
      duration: 180,
      elapsedTimeNow: 12,
      playing: true,
      bundleIdentifier: "com.Spotify.client",
    }
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      now: () => now,
      run: async (command) => ({
        ok: true,
        out: JSON.stringify(
          command.includes("--no-artwork")
            ? payload
            : { ...payload, artworkData: "cover" },
        ),
      }),
      resolveArtworkDetails: async () => {
        resolutions++
        if (resolutions === 1) throw new Error("artwork unavailable")
        return { artwork: null, duration_ms: 180_000 }
      },
    })
    backend.subscribePresentation?.((event) => completions.push(event))

    const first = await Promise.all([backend.player(), backend.player()])
    expect(first.map((state) => state?.track?.artwork_loading)).toEqual([
      true,
      true,
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolutions).toBe(1)
    expect(completions).toEqual([
      expect.objectContaining({ artwork: null, duration_ms: 180_000 }),
    ])

    const cachedFailure = await backend.player()
    expect(cachedFailure?.track?.artwork_loading).toBe(false)
    expect(resolutions).toBe(1)

    now += 2_000
    const retried = await backend.player()
    expect(retried?.track?.artwork_loading).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolutions).toBe(2)
  })

  test("shares artwork work across provider ids and returns a settled cache hit", async () => {
    const pending = {
      resolve: null as
        | ((value: {
            artwork: {
              id: string
              png_base64: string
              accent: string
              cells: []
            }
            duration_ms: number
          }) => void)
        | null,
    }
    const artwork = new Promise<{
      artwork: { id: string; png_base64: string; accent: string; cells: [] }
      duration_ms: number
    }>((resolve) => {
      pending.resolve = resolve
    })
    let samples = 0
    let resolutions = 0
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) => ({
        ok: true,
        out: JSON.stringify({
          contentItemIdentifier: command.includes("--no-artwork")
            ? ++samples === 1
              ? "playing-id"
              : "paused-id"
            : "playing-id",
          title: "Shared Cache Song",
          artist: "Artist",
          album: "Album",
          duration: 180,
          elapsedTimeNow: 12,
          playing: false,
          artworkData: "cover",
          bundleIdentifier: "com.Spotify.client",
        }),
      }),
      resolveArtworkDetails: () => {
        resolutions++
        return artwork
      },
    })
    const completions: unknown[] = []
    backend.subscribePresentation?.((event) => completions.push(event))

    const first = await backend.player()
    const second = await backend.player()
    expect(first?.track?.artwork_loading).toBe(true)
    expect(second?.track?.artwork_loading).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolutions).toBe(1)

    const cover = {
      id: "cover",
      png_base64: "png",
      accent: "blue",
      cells: [] as [],
    }
    pending.resolve?.({ artwork: cover, duration_ms: 180_000 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completions).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ uid: "paused-id" }),
        artwork: cover,
      }),
    ])

    const cached = await backend.player()
    expect(cached?.track).toMatchObject({
      artwork: cover,
      artwork_loading: false,
    })
    expect(resolutions).toBe(1)
  })

  test("keeps the oldest unresolved artwork job deduplicated past the settled cache bound", async () => {
    const pending = {
      resolve: null as
        ((value: { artwork: null; duration_ms: number }) => void) | null,
    }
    const artwork = new Promise<{ artwork: null; duration_ms: number }>(
      (resolve) => {
        pending.resolve = resolve
      },
    )
    let sample = 0
    const resolutions: string[] = []
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) => {
        if (!command.includes("--no-artwork")) return { ok: true, out: "" }
        const index = sample++ === 33 ? 0 : sample - 1
        return {
          ok: true,
          out: JSON.stringify({
            contentItemIdentifier: `provider-${index}`,
            title: `Eviction Artwork Song ${index}`,
            artist: "Artist",
            album: "Album",
            duration: 180,
            elapsedTimeNow: 12,
            playing: false,
            bundleIdentifier: "com.Spotify.client",
          }),
        }
      },
      resolveArtworkDetails: (_key, target) => {
        resolutions.push(target.title)
        return target.title === "Eviction Artwork Song 0"
          ? artwork
          : Promise.resolve({ artwork: null, duration_ms: 180_000 })
      },
    })

    for (let index = 0; index < 33; index++) await backend.player()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolutions).toHaveLength(33)
    expect(
      resolutions.filter((title) => title === "Eviction Artwork Song 0"),
    ).toHaveLength(1)

    const repeated = await backend.player()
    expect(repeated?.track?.artwork_loading).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolutions).toHaveLength(33)
    expect(
      resolutions.filter((title) => title === "Eviction Artwork Song 0"),
    ).toHaveLength(1)

    pending.resolve?.({ artwork: null, duration_ms: 180_000 })
  })

  test("projects playback and stream snapshots before detached artwork settles", async () => {
    const resolver = {
      resolve: null as
        ((value: { artwork: null; duration_ms: number }) => void) | null,
    }
    const artwork = new Promise<{ artwork: null; duration_ms: number }>(
      (resolve) => {
        resolver.resolve = resolve
      },
    )
    const payload = {
      contentItemIdentifier: "artwork-lane-id",
      title: "Artwork Lane Song",
      artist: "Artist",
      album: "Album",
      duration: 180,
      elapsedTimeNow: 12,
      playing: false,
      bundleIdentifier: "com.Spotify.client",
    }
    const stream = { listener: null as ((line: string) => void) | null }
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) => ({
        ok: true,
        out: JSON.stringify(
          command.includes("--no-artwork")
            ? payload
            : { ...payload, artworkData: "cover" },
        ),
      }),
      resolveArtworkDetails: () => artwork,
      startLineStream: (_command, callbacks) => {
        stream.listener = callbacks.onLine
        return () => {}
      },
      setRetryTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearRetryTimer: () => {},
    })
    const completions: unknown[] = []
    const snapshots: unknown[] = []
    const disposePresentation = backend.subscribePresentation?.((event) =>
      completions.push(event),
    )
    backend.subscribe?.((event) => snapshots.push(event))

    const initial = await backend.player()
    expect(initial?.track).toMatchObject({
      artwork: null,
      artwork_loading: true,
    })
    stream.listener?.(JSON.stringify({ type: "data", payload }))
    expect(snapshots).toHaveLength(1)
    expect(
      (snapshots[0] as { state: typeof initial }).state?.track,
    ).toMatchObject({
      artwork_loading: true,
    })

    disposePresentation?.()
    disposePresentation?.()
    resolver.resolve?.({ artwork: null, duration_ms: 180_000 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completions).toHaveLength(0)
  })

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
    stream.listener?.(
      JSON.stringify({
        type: "data",
        payload: {
          contentItemIdentifier: "provider-id",
          title: "Song",
          artist: "Artist",
          album: "Album",
          duration: 180,
          elapsedTimeNow: 0,
          playing: false,
          bundleIdentifier: "com.Spotify.client",
        },
      }),
    )
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
