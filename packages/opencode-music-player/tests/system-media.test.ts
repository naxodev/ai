import { describe, expect, test } from "bun:test"
import {
  trackKey,
  type ArtworkIdentity as SessionArtworkIdentity,
  type ArtworkResult as SessionArtworkResult,
  type MusicSessionConnectionLifecycle,
  type ProviderStatus,
  type ReconnectingMusicSessionClient,
  type RevisionedState,
} from "@naxodev/music-core"
import {
  artworkCacheKey,
  artworkDataForIdentity,
  artworkIdentityKey,
  createSessionSystemMedia,
  createSystemMedia,
} from "../system-media.ts"

const sessionState = (
  name: string,
  revision: number,
  daemonInstanceId = "daemon-a",
): RevisionedState => ({
  daemonInstanceId,
  revision,
  state: {
    is_playing: false,
    progress_ms: 12,
    shuffle: false,
    repeat: "off",
    device: null,
    track: {
      id: `id-${name}`,
      uri: `system:${name}`,
      name,
      artists: "Artist",
      album: "Album",
      duration_ms: 180_000,
    },
    fetched_at: 1,
  },
})

class FakeReconnectingClient implements ReconnectingMusicSessionClient {
  daemonInstanceId = "daemon-a"
  negotiatedCapabilities = ["state-replay", "transport", "native-artwork"]
  selectedRevision = 1
  status: ProviderStatus | undefined = {
    kind: "ready",
    provider: "media-control",
    message: "ready",
  }
  state: RevisionedState | undefined = sessionState("one", 4)
  connection: MusicSessionConnectionLifecycle = {
    type: "connected",
    daemonInstanceId: "daemon-a",
  }
  readonly statusListeners = new Set<(status: ProviderStatus) => void>()
  readonly stateListeners = new Set<(state: RevisionedState) => void>()
  readonly connectionListeners = new Set<
    (connection: MusicSessionConnectionLifecycle) => void
  >()
  readonly calls: string[] = []
  readonly artworkCalls: SessionArtworkIdentity[] = []
  artworkResult: SessionArtworkResult = { type: "unavailable" }
  artworkFailure: unknown | undefined
  private readonly commandGates = new Map<string, Promise<void>>()
  private artworkGate: Promise<SessionArtworkResult> | undefined
  private disposeGate: Promise<void> | undefined
  disposeCalls = 0
  unsubscribeCalls = { state: 0, status: 0, connection: 0 }

  subscribeStatus(listener: (status: ProviderStatus) => void) {
    this.statusListeners.add(listener)
    if (this.status) listener(this.status)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      this.unsubscribeCalls.status++
      this.statusListeners.delete(listener)
    }
  }
  subscribeState(listener: (state: RevisionedState) => void) {
    this.stateListeners.add(listener)
    if (this.state) listener(this.state)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      this.unsubscribeCalls.state++
      this.stateListeners.delete(listener)
    }
  }
  subscribeConnection(
    listener: (connection: MusicSessionConnectionLifecycle) => void,
  ) {
    this.connectionListeners.add(listener)
    listener(this.connection)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      this.unsubscribeCalls.connection++
      this.connectionListeners.delete(listener)
    }
  }
  emitState(state: RevisionedState) {
    this.state = state
    this.daemonInstanceId = state.daemonInstanceId
    for (const listener of [...this.stateListeners]) listener(state)
  }
  emitStatus(status: ProviderStatus) {
    this.status = status
    for (const listener of [...this.statusListeners]) listener(status)
  }
  emitConnection(connection: MusicSessionConnectionLifecycle) {
    this.connection = connection
    for (const listener of [...this.connectionListeners]) listener(connection)
  }
  holdCommand(command: string, gate: Promise<void>) {
    this.commandGates.set(command, gate)
  }
  holdArtwork(gate: Promise<SessionArtworkResult>) {
    this.artworkGate = gate
  }
  holdDisposal(gate: Promise<void>) {
    this.disposeGate = gate
  }
  async toggle() {
    this.calls.push("toggle")
    await this.commandGates.get("toggle")
    return { action: "toggle" as const }
  }
  async play() {
    this.calls.push("play")
    await this.commandGates.get("play")
    return { action: "play" as const }
  }
  async pause() {
    this.calls.push("pause")
    await this.commandGates.get("pause")
    return { action: "pause" as const }
  }
  async next() {
    this.calls.push("next")
    await this.commandGates.get("next")
    return { action: "next" as const }
  }
  async previous() {
    this.calls.push("previous")
    await this.commandGates.get("previous")
    return { action: "previous" as const }
  }
  async seek(positionMs: number) {
    this.calls.push(`seek:${positionMs}`)
    await this.commandGates.get("seek")
    return { action: "seek" as const }
  }
  async artwork(identity: SessionArtworkIdentity) {
    this.artworkCalls.push(identity)
    if (this.artworkFailure !== undefined) throw this.artworkFailure
    return this.artworkGate ?? this.artworkResult
  }
  async dispose() {
    this.disposeCalls++
    await this.disposeGate
  }
}

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

describe("session-media facade", () => {
  test("reports a one-shot factory failure identically to early and late observers", async () => {
    let factories = 0
    const backend = createSessionSystemMedia({
      createClient: async () => {
        factories++
        throw new Error("factory unavailable")
      },
    })
    const early: Array<{ type?: string; message?: string | null }> = []
    backend.subscribe?.((event) => early.push(event ?? {}))
    await expect(backend.player()).rejects.toThrow("factory unavailable")
    await Promise.resolve()
    const late: Array<{ type?: string; message?: string | null }> = []
    backend.subscribe?.((event) => late.push(event ?? {}))

    expect(factories).toBe(1)
    expect(early).toEqual([
      { type: "lifecycle", message: "factory unavailable" },
    ])
    expect(late).toEqual([
      { type: "lifecycle", message: "factory unavailable" },
    ])
    await backend.dispose?.()
  })

  test("isolates throwing adapter observers from later observers", async () => {
    const client = new FakeReconnectingClient()
    const backend = createSessionSystemMedia({
      createClient: async () => client,
    })
    const received: unknown[] = []
    backend.subscribe?.(() => {
      throw new Error("observer failure")
    })
    backend.subscribe?.((event) => received.push(event))

    await backend.player()
    client.emitState(sessionState("later", 5))

    expect(received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "snapshot",
          state: expect.objectContaining({
            track: expect.objectContaining({ name: "later" }),
          }),
        }),
      ]),
    )
    await backend.dispose?.()
  })

  test("uses one public reconnecting client for concurrent operations and accepts replacement replay", async () => {
    const client = new FakeReconnectingClient()
    let factories = 0
    const backend = createSessionSystemMedia({
      createClient: async () => {
        factories++
        return client
      },
    })
    const events: unknown[] = []
    const unsubscribe = backend.subscribe?.((event) => events.push(event))
    const players = await Promise.all(
      Array.from({ length: 20 }, () => backend.player()),
    )
    expect(factories).toBe(1)
    expect(players.every((player) => player?.track?.name === "one")).toBe(true)

    client.emitConnection({
      type: "reconnecting",
      error: {
        code: "CONNECTION_LOST",
        message: "lost",
        retryable: true,
      } as never,
    })
    client.emitState(sessionState("two", 1, "daemon-b"))
    expect((await backend.player())?.track?.name).toBe("two")
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "lifecycle", message: "lost" }),
        expect.objectContaining({
          type: "snapshot",
          state: expect.objectContaining({
            track: expect.objectContaining({ name: "two" }),
          }),
        }),
      ]),
    )
    unsubscribe?.()
    await backend.dispose?.()
  })

  test("retains connection errors over ready status and provider degradation after reconnect", async () => {
    const client = new FakeReconnectingClient()
    const backend = createSessionSystemMedia({
      createClient: async () => client,
    })
    const events: Array<{ type?: string; message?: string | null }> = []
    backend.subscribe?.((event) => events.push(event ?? {}))
    await backend.player()

    client.emitConnection({
      type: "reconnecting",
      error: {
        code: "CONNECTION_LOST",
        message: "reconnecting",
        retryable: true,
      } as never,
    })
    client.emitStatus({
      kind: "ready",
      provider: "media-control",
      message: "ready",
    })
    expect(events.at(-1)).toEqual({
      type: "lifecycle",
      message: "reconnecting",
    })

    client.emitConnection({ type: "connected", daemonInstanceId: "daemon-b" })
    client.emitStatus({
      kind: "degraded",
      provider: "nowplaying-cli",
      message: "fallback",
    })
    expect(events.at(-1)).toEqual({ type: "lifecycle", message: "fallback" })

    client.emitConnection({
      type: "terminal",
      error: {
        code: "INCOMPATIBLE_PROTOCOL",
        message: "incompatible",
      } as never,
    })
    await backend.player()
    expect(events.at(-1)).toEqual({
      type: "lifecycle",
      message: "incompatible",
    })
    await backend.dispose?.()
  })

  test("deduplicates public replay and replays retained state/lifecycle to late observers", async () => {
    const client = new FakeReconnectingClient()
    client.status = {
      kind: "degraded",
      provider: "nowplaying-cli",
      message: "fallback",
    }
    const backend = createSessionSystemMedia({
      createClient: async () => client,
    })
    const early: Array<{ type?: string; message?: string | null }> = []
    backend.subscribe?.((event) => early.push(event ?? {}))
    await backend.player()
    expect(early.filter((event) => event.type === "lifecycle")).toEqual([
      { type: "lifecycle", message: "fallback" },
    ])

    const late: Array<{ type?: string; message?: string | null; state?: any }> =
      []
    backend.subscribe?.((event) => late.push(event ?? {}))
    expect(late).toEqual([
      expect.objectContaining({
        type: "snapshot",
        state: expect.objectContaining({
          track: expect.objectContaining({ name: "one" }),
        }),
      }),
      { type: "lifecycle", message: "fallback" },
    ])

    client.emitConnection({ type: "connected", daemonInstanceId: "daemon-b" })
    client.emitStatus({
      kind: "ready",
      provider: "media-control",
      message: "ready",
    })
    expect(early.filter((event) => event.type === "lifecycle")).toEqual([
      { type: "lifecycle", message: "fallback" },
      { type: "lifecycle", message: null },
    ])
    await backend.dispose?.()
    expect(client.unsubscribeCalls).toEqual({
      state: 1,
      status: 1,
      connection: 1,
    })
    expect(client.disposeCalls).toBe(1)
  })

  test("delegates controls and native artwork through the client only", async () => {
    const client = new FakeReconnectingClient()
    client.state = sessionState("native", 4)
    client.artworkResult = { type: "available", base64: "AQID" }
    const native: Array<string | null> = []
    const backend = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: async (_key, _target, data) => {
        native.push(data)
        return { artwork: null, duration_ms: 180_000 }
      },
    })
    await backend.player()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.all([
      backend.play(),
      backend.pause?.(),
      backend.next?.(),
      backend.previous?.(),
      backend.seek?.(4321),
    ])
    expect(client.calls).toEqual([
      "play",
      "pause",
      "next",
      "previous",
      "seek:4321",
    ])
    expect(client.artworkCalls).toEqual([
      {
        id: "id-native",
        name: "native",
        artists: "Artist",
        album: "Album",
        duration_ms: 180_000,
      },
    ])
    expect(native).toEqual(["AQID"])
    await backend.dispose?.()
  })

  test("does not replay held commands or start fallback artwork after disposal", async () => {
    const client = new FakeReconnectingClient()
    client.state = sessionState("held-work", 1)
    let releaseCommand: (() => void) | undefined
    let releaseArtwork: ((result: SessionArtworkResult) => void) | undefined
    const command = new Promise<void>((resolve) => {
      releaseCommand = resolve
    })
    const artwork = new Promise<SessionArtworkResult>((resolve) => {
      releaseArtwork = resolve
    })
    client.holdCommand("play", command)
    client.holdArtwork(artwork)
    let resolutions = 0
    const backend = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: async () => {
        resolutions++
        return { artwork: null, duration_ms: 180_000 }
      },
    })

    try {
      await backend.player()
      await Promise.resolve()
      const playing = backend.play()
      await Promise.resolve()
      const disposal = backend.dispose?.()
      releaseCommand?.()
      releaseArtwork?.({ type: "available", base64: "late" })
      await Promise.all([playing, disposal])
      await Promise.resolve()

      expect(client.calls).toEqual(["play"])
      expect(client.artworkCalls).toHaveLength(1)
      expect(resolutions).toBe(0)
      expect(client.disposeCalls).toBe(1)
    } finally {
      releaseCommand?.()
      releaseArtwork?.({ type: "available", base64: "late" })
      await backend.dispose?.()
    }
  })

  test("falls back for bounded non-available and rejected native artwork", async () => {
    for (const result of [
      { type: "unavailable" },
      { type: "stale" },
      { type: "too-large" },
    ] as SessionArtworkResult[]) {
      const client = new FakeReconnectingClient()
      const name = `fallback-${result.type}`
      client.state = sessionState(name, 1)
      client.artworkResult = result
      const native: Array<string | null> = []
      const backend = createSessionSystemMedia({
        createClient: async () => client,
        resolveArtworkDetails: async (_key, target, data) => {
          expect(target.title).toBe(name)
          native.push(data)
          return { artwork: null, duration_ms: 180_000 }
        },
      })
      await backend.player()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(native).toEqual([null])
      await backend.dispose?.()
    }

    const rejected = new FakeReconnectingClient()
    rejected.state = sessionState("fallback-rejected", 1)
    rejected.artworkFailure = new Error("disconnected")
    const native: Array<string | null> = []
    const backend = createSessionSystemMedia({
      createClient: async () => rejected,
      resolveArtworkDetails: async (_key, _target, data) => {
        native.push(data)
        return { artwork: null, duration_ms: 180_000 }
      },
    })
    await backend.player()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(native).toEqual([null])
    await backend.dispose?.()
  })

  test("disposal suppresses a late session artwork resolver completion", async () => {
    const client = new FakeReconnectingClient()
    client.state = sessionState("late-artwork", 1)
    client.artworkResult = { type: "available", base64: "AQID" }
    let resolveArtwork:
      ((value: { artwork: null; duration_ms: number }) => void) | undefined
    const completions: unknown[] = []
    const backend = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: () =>
        new Promise((resolve) => {
          resolveArtwork = resolve
        }),
    })
    backend.subscribePresentation?.((event) => completions.push(event))
    await backend.player()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const first = backend.dispose?.()
    const second = backend.dispose?.()
    expect(second).toBe(first)
    resolveArtwork?.({ artwork: null, duration_ms: 180_000 })
    await first
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completions).toEqual([])
    expect(client.disposeCalls).toBe(1)
  })

  test("released artwork work cannot mutate a replacement host cache or presentation", async () => {
    const first = new FakeReconnectingClient()
    first.state = sessionState("shared-artwork", 1, "daemon-a")
    first.artworkResult = { type: "available", base64: "first" }
    let resolveFirst:
      ((value: { artwork: any; duration_ms: number }) => void) | undefined
    const backendA = createSessionSystemMedia({
      createClient: async () => first,
      resolveArtworkDetails: () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
    })
    await backendA.player()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await backendA.dispose?.()

    const second = new FakeReconnectingClient()
    second.state = {
      ...sessionState("shared-artwork", 1, "daemon-b"),
      state: {
        ...sessionState("shared-artwork", 1, "daemon-b").state,
        track: {
          ...sessionState("shared-artwork", 1, "daemon-b").state.track!,
          id: "replacement-provider-id",
        },
      },
    }
    second.artworkResult = { type: "available", base64: "second" }
    const presentations: Array<{ identity: { uid: string }; artwork: any }> = []
    const replacementArtwork = {
      id: "replacement",
      png_base64: "",
      accent: "",
      cells: [],
    }
    const backendB = createSessionSystemMedia({
      createClient: async () => second,
      resolveArtworkDetails: async () => ({
        artwork: replacementArtwork,
        duration_ms: 180_000,
      }),
    })
    backendB.subscribePresentation?.((event) =>
      presentations.push(event as any),
    )
    await backendB.player()
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveFirst?.({
      artwork: { id: "stale", png_base64: "", accent: "", cells: [] },
      duration_ms: 180_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(presentations).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ uid: "replacement-provider-id" }),
        artwork: replacementArtwork,
      }),
    ])
    expect((await backendB.player())?.track?.artwork).toBe(replacementArtwork)
    await backendB.dispose?.()
  })

  test("releasing a successful owner preserves a replacement cache hit", async () => {
    const first = new FakeReconnectingClient()
    first.state = sessionState("shared-success", 1, "daemon-a")
    first.artworkResult = { type: "available", base64: "first" }
    const artwork = { id: "shared", png_base64: "", accent: "", cells: [] }
    const backendA = createSessionSystemMedia({
      createClient: async () => first,
      resolveArtworkDetails: async () => ({ artwork, duration_ms: 180_000 }),
    })
    await backendA.player()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const second = new FakeReconnectingClient()
    second.state = {
      ...sessionState("shared-success", 1, "daemon-b"),
      state: {
        ...sessionState("shared-success", 1, "daemon-b").state,
        track: {
          ...sessionState("shared-success", 1, "daemon-b").state.track!,
          id: "replacement-success-id",
        },
      },
    }
    const backendB = createSessionSystemMedia({
      createClient: async () => second,
      resolveArtworkDetails: async () => {
        throw new Error("replacement should use cache")
      },
    })
    expect((await backendB.player())?.track?.artwork).toBe(artwork)
    expect(second.artworkCalls).toEqual([])
    await backendA.dispose?.()
    expect((await backendB.player())?.track?.artwork).toBe(artwork)
    expect(second.artworkCalls).toEqual([])
    await backendB.dispose?.()
  })

  test("released exhausted artwork work cannot retain a retry budget for a replacement", async () => {
    let now = 0
    const first = new FakeReconnectingClient()
    first.state = sessionState("exhausted-artwork", 1, "daemon-a")
    const backendA = createSessionSystemMedia({
      createClient: async () => first,
      now: () => now,
      resolveArtworkDetails: async () => ({
        artwork: null,
        duration_ms: 180_000,
      }),
    })
    for (const nextNow of [0, 2_000, 6_000]) {
      now = nextNow
      await backendA.player()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(first.artworkCalls).toHaveLength(3)
    await backendA.dispose?.()

    const second = new FakeReconnectingClient()
    second.state = {
      ...sessionState("exhausted-artwork", 1, "daemon-b"),
      state: {
        ...sessionState("exhausted-artwork", 1, "daemon-b").state,
        track: {
          ...sessionState("exhausted-artwork", 1, "daemon-b").state.track!,
          id: "replacement-exhausted-id",
        },
      },
    }
    let replacementResolutions = 0
    const backendB = createSessionSystemMedia({
      createClient: async () => second,
      now: () => now,
      resolveArtworkDetails: async () => {
        replacementResolutions++
        return { artwork: null, duration_ms: 180_000 }
      },
    })
    await backendB.player()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(second.artworkCalls).toHaveLength(1)
    expect(replacementResolutions).toBe(1)
    await backendB.dispose?.()
  })

  test("post-disposal subscriptions and operations are inert", async () => {
    const client = new FakeReconnectingClient()
    client.state = undefined
    const backend = createSessionSystemMedia({
      createClient: async () => client,
    })
    await backend.player()
    await backend.dispose?.()
    let stateEvents = 0
    let presentationEvents = 0
    const unsubscribe = backend.subscribe?.(() => stateEvents++)
    const unsubscribePresentation = backend.subscribePresentation?.(
      () => presentationEvents++,
    )
    client.emitState(sessionState("ignored", 2))
    client.emitStatus({
      kind: "degraded",
      provider: "nowplaying-cli",
      message: "ignored",
    })
    client.emitConnection({
      type: "reconnecting",
      error: { message: "ignored", retryable: true } as never,
    })
    await expect(backend.player()).rejects.toThrow("disposed")
    await expect(backend.play()).rejects.toThrow("disposed")
    unsubscribe?.()
    unsubscribePresentation?.()
    expect(stateEvents).toBe(0)
    expect(presentationEvents).toBe(0)
    expect(client.calls).toEqual([])
    expect(client.unsubscribeCalls).toEqual({
      state: 1,
      status: 1,
      connection: 1,
    })
  })

  test("disposes a late client and clears active public subscriptions exactly once", async () => {
    const lateClient = new FakeReconnectingClient()
    let resolveClient:
      ((client: ReconnectingMusicSessionClient) => void) | undefined
    const late = new Promise<ReconnectingMusicSessionClient>((resolve) => {
      resolveClient = resolve
    })
    const backend = createSessionSystemMedia({ createClient: () => late })
    const unsubscribe = backend.subscribe?.(() => {})
    const disposal = backend.dispose?.()
    resolveClient?.(lateClient)
    await disposal
    unsubscribe?.()
    expect(lateClient.disposeCalls).toBe(1)
    expect(lateClient.stateListeners.size).toBe(0)
    expect(lateClient.statusListeners.size).toBe(0)
    expect(lateClient.connectionListeners.size).toBe(0)
  })
})
