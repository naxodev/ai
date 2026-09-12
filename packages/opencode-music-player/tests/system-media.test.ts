import { describe, expect, spyOn, test } from "bun:test"
import { acquireCatalogArtwork } from "@naxodev/music-core"
import type {
  ArtworkIdentity,
  ArtworkResult,
  MusicSessionConnectionLifecycle,
  ProviderStatus,
  ReconnectingMusicSessionClient,
  RevisionedState,
} from "@naxodev/music-core"
import {
  artworkCacheKey,
  artworkIdentityKey,
  createSessionSystemMedia,
} from "../system-media.ts"
import type { PlayerState } from "../types.ts"

const state = (
  name: string,
  revision = 1,
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
    fetched_at: 1,
    track: {
      id: `id-${name}`,
      uri: `system:${name}`,
      name,
      artists: "Artist",
      album: "Album",
      duration_ms: 180_000,
    },
  },
})

class FakeClient implements ReconnectingMusicSessionClient {
  daemonInstanceId = "daemon-a"
  selectedRevision = 1
  negotiatedCapabilities = ["state-replay", "transport", "native-artwork"]
  state: RevisionedState | undefined = state("one", 4)
  status: ProviderStatus | undefined = {
    kind: "ready",
    provider: "media-control",
    message: "ready",
  }
  connection: MusicSessionConnectionLifecycle = {
    type: "connected",
    daemonInstanceId: "daemon-a",
  }
  stateListeners = new Set<(value: RevisionedState) => void>()
  statusListeners = new Set<(value: ProviderStatus) => void>()
  connectionListeners = new Set<
    (value: MusicSessionConnectionLifecycle) => void
  >()
  calls: string[] = []
  artworkCalls: ArtworkIdentity[] = []
  artworkResult: ArtworkResult = { type: "unavailable" }
  artworkFailure: unknown | undefined
  disposeCalls = 0
  commandGate: Promise<void> | undefined
  artworkGate: Promise<ArtworkResult> | undefined

  subscribeState(listener: (value: RevisionedState) => void) {
    this.stateListeners.add(listener)
    if (this.state) listener(this.state)
    return () => this.stateListeners.delete(listener)
  }
  subscribeStatus(listener: (value: ProviderStatus) => void) {
    this.statusListeners.add(listener)
    if (this.status) listener(this.status)
    return () => this.statusListeners.delete(listener)
  }
  subscribeConnection(
    listener: (value: MusicSessionConnectionLifecycle) => void,
  ) {
    this.connectionListeners.add(listener)
    listener(this.connection)
    return () => this.connectionListeners.delete(listener)
  }
  emitState(next: RevisionedState) {
    this.state = next
    this.daemonInstanceId = next.daemonInstanceId
    for (const listener of [...this.stateListeners]) listener(next)
  }
  emitStatus(next: ProviderStatus) {
    this.status = next
    for (const listener of [...this.statusListeners]) listener(next)
  }
  emitConnection(next: MusicSessionConnectionLifecycle) {
    this.connection = next
    for (const listener of [...this.connectionListeners]) listener(next)
  }
  async toggle() {
    return { action: "toggle" as const }
  }
  async play() {
    this.calls.push("play")
    await this.commandGate
    return { action: "play" as const }
  }
  async pause() {
    this.calls.push("pause")
    await this.commandGate
    return { action: "pause" as const }
  }
  async next() {
    this.calls.push("next")
    await this.commandGate
    return { action: "next" as const }
  }
  async previous() {
    this.calls.push("previous")
    await this.commandGate
    return { action: "previous" as const }
  }
  async seek(position: number) {
    this.calls.push(`seek:${position}`)
    await this.commandGate
    return { action: "seek" as const }
  }
  async artwork(identity: ArtworkIdentity) {
    this.artworkCalls.push(identity)
    if (this.artworkFailure !== undefined) throw this.artworkFailure
    return this.artworkGate ?? this.artworkResult
  }
  async dispose() {
    this.disposeCalls++
  }
}

const flush = () => Promise.resolve().then(() => Promise.resolve())

describe("session media facade", () => {
  test("UID-only changes retain recording work and publish under the current full identity", async () => {
    const client = new FakeClient()
    client.state = state("uid-stable-recording")
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    const completed = Promise.withResolvers<string>()
    let signal: AbortSignal | null | undefined
    let requests = 0
    let resolutions = 0
    const media = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: async (
        _key,
        target,
        _native,
        _legacy,
        _fetch,
        ownerSignal,
      ) => {
        resolutions++
        await acquireCatalogArtwork(target, {
          signal: ownerSignal,
          fetch: async (_url, init) => {
            requests++
            signal = init?.signal
            started.resolve()
            return response.promise
          },
        })
        return { artwork: null, duration_ms: target.duration_ms }
      },
    })
    media.subscribePresentation((event) =>
      completed.resolve(event.identity.uid),
    )
    await media.player()
    await started.promise
    const replacement = state("uid-stable-recording", 2)
    client.emitState({
      ...replacement,
      state: {
        ...replacement.state,
        track: { ...replacement.state.track!, id: "replacement-provider-id" },
      },
    })
    await media.player()
    expect(signal?.aborted).toBe(false)
    expect(client.artworkCalls).toHaveLength(1)
    expect(resolutions).toBe(1)
    response.resolve(Response.json({ results: [] }))
    expect(await completed.promise).toBe("replacement-provider-id")
    expect(requests).toBe(1)
    expect(resolutions).toBe(1)
    await media.dispose()
  })

  test("shared acquisition exhausts once, refresh recovers the same track, and active refreshes share one job", async () => {
    const client = new FakeClient()
    client.state = state("catalog-refresh")
    let online = false
    let requests = 0
    const searchGate = Promise.withResolvers<void>()
    const completed: Array<string | null> = []
    let nextCompletion = Promise.withResolvers<void>()
    const media = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: async (
        key,
        target,
        _native,
        _legacy,
        _fetch,
        signal,
      ) => {
        const result = await acquireCatalogArtwork(target, {
          signal,
          retryDelayMs: 0,
          fetch: async (url) => {
            requests++
            if (!online) return new Response(null, { status: 503 })
            if (new URL(String(url)).hostname === "itunes.apple.com") {
              await searchGate.promise
              return Response.json({
                results: [
                  {
                    trackName: target.title,
                    artistName: target.artist,
                    collectionName: target.album,
                    trackTimeMillis: target.duration_ms,
                    artworkUrl100: "https://is1.mzstatic.com/100x100bb.jpg",
                  },
                ],
              })
            }
            return new Response(new Uint8Array([1]))
          },
        })
        return {
          duration_ms: target.duration_ms,
          artwork:
            result.kind === "available"
              ? {
                  id: key,
                  png_base64: "controlled",
                  accent: "#000000",
                  cells: [],
                }
              : null,
        }
      },
    })
    media.subscribePresentation((event) => {
      completed.push(event.artwork?.png_base64 ?? null)
      nextCompletion.resolve()
    })
    await media.player()
    await nextCompletion.promise
    expect(requests).toBe(3)
    await media.player()
    expect(requests).toBe(3)
    online = true
    nextCompletion = Promise.withResolvers<void>()
    await Promise.all([media.refreshArtwork(), media.refreshArtwork()])
    searchGate.resolve()
    await nextCompletion.promise
    expect(requests).toBe(5)
    expect(completed).toEqual([null, "controlled"])
    expect((await media.player())?.track?.name).toBe("catalog-refresh")
    expect(client.calls).toEqual([])
    await media.dispose()
  })

  test("track replacement and disposal abort shared catalog reads and fence late completions", async () => {
    const client = new FakeClient()
    client.state = state("catalog-stale-a")
    const starts = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ]
    const responses = [
      Promise.withResolvers<Response>(),
      Promise.withResolvers<Response>(),
    ]
    const signals: AbortSignal[] = []
    const completions: unknown[] = []
    let cancelled = 0
    const media = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: async (
        _key,
        target,
        _native,
        _legacy,
        _fetch,
        signal,
      ) => {
        await acquireCatalogArtwork(target, {
          signal,
          fetch: async (_url, init) => {
            const index = signals.length
            signals.push(init!.signal!)
            starts[index]!.resolve()
            return responses[index]!.promise
          },
        })
        return { artwork: null, duration_ms: target.duration_ms }
      },
    })
    media.subscribePresentation((event) => completions.push(event))
    await media.player()
    await starts[0]!.promise
    client.emitState(state("catalog-stale-b", 2))
    // Subscribe state projection so the facade observes replacement immediately.
    await media.player()
    await starts[1]!.promise
    expect(signals[0]!.aborted).toBe(true)
    await media.dispose()
    expect(signals[1]!.aborted).toBe(true)
    for (const response of responses)
      response.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++
            },
          }),
        ),
      )
    for (let i = 0; i < 30; i++) await flush()
    expect(cancelled).toBe(2)
    expect(completions).toEqual([])
  })

  test("provider status recovery clears the host warning and fallback remains visible", async () => {
    const client = new FakeClient()
    const media = createSessionSystemMedia({ createClient: async () => client })
    const events: unknown[] = []
    media.subscribe((event) => events.push(event))
    await media.player()
    for (const status of [
      {
        kind: "degraded",
        provider: "media-control",
        message: "provider sample failed",
      },
      {
        kind: "ready",
        provider: "media-control",
        message: "media-control ready",
      },
      {
        kind: "degraded",
        provider: "nowplaying-cli",
        message: "using nowplaying-cli",
      },
      {
        kind: "degraded",
        provider: "nowplaying-cli",
        message: "command worker failed",
      },
    ] satisfies ProviderStatus[]) {
      client.emitStatus(status)
      expect(events.at(-1)).toEqual({
        type: "lifecycle",
        source: "provider",
        message: status.kind === "ready" ? null : status.message,
      })
    }
    expect(client.calls).toEqual([])
    await media.dispose()
  })

  test("disposal aborts cooperative acquisition without publishing a failure", async () => {
    let signal: AbortSignal | undefined
    let aborted = 0
    const media = createSessionSystemMedia({
      createClient: (acquisitionSignal) => {
        signal = acquisitionSignal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborted++
              reject(signal?.reason)
            },
            { once: true },
          )
        })
      },
    })
    const events: unknown[] = []
    media.subscribe((event) => events.push(event))
    await flush()
    const disposal = media.dispose()
    expect(media.dispose()).toBe(disposal)
    await disposal
    await flush()
    expect(signal?.aborted).toBeTrue()
    expect(aborted).toBe(1)
    expect(events).toEqual([])
  })

  test("an uncooperative factory cannot hold disposal open", async () => {
    let signal: AbortSignal | undefined
    const media = createSessionSystemMedia({
      createClient: (acquisitionSignal) => {
        signal = acquisitionSignal
        return new Promise(() => {})
      },
    })
    await flush()
    let settled = false
    const disposal = media.dispose().then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBeTrue()
    expect(signal?.aborted).toBeTrue()
    await disposal
  })

  test("late success is released once without installing subscriptions or artwork", async () => {
    let resolve!: (client: ReconnectingMusicSessionClient) => void
    const client = new FakeClient()
    const media = createSessionSystemMedia({
      createClient: () =>
        new Promise((next) => {
          resolve = next
        }),
    })
    const events: unknown[] = []
    media.subscribe((event) => events.push(event))
    media.subscribePresentation((event) => events.push(event))
    await flush()
    let settled = false
    const disposal = media.dispose()
    void disposal.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBeTrue()
    resolve(client)
    await flush()
    await media.dispose()
    expect(media.dispose()).toBe(disposal)
    expect(client.disposeCalls).toBe(1)
    expect(client.stateListeners.size).toBe(0)
    expect(client.statusListeners.size).toBe(0)
    expect(client.connectionListeners.size).toBe(0)
    expect(client.artworkCalls).toEqual([])
    expect(events).toEqual([])
    await expect(media.player()).rejects.toThrow("music session is disposed")
  })

  test("late cleanup failures are reported without an unhandled rejection", async () => {
    const report = spyOn(console, "error").mockImplementation(() => {})
    try {
      let resolve!: (client: ReconnectingMusicSessionClient) => void
      const client = new FakeClient()
      const failure = new Error("late cleanup failed")
      client.dispose = async () => {
        client.disposeCalls++
        throw failure
      }
      const media = createSessionSystemMedia({
        createClient: () =>
          new Promise((next) => {
            resolve = next
          }),
      })
      await flush()
      void media.dispose()
      resolve(client)
      await flush()
      await flush()
      expect(report).toHaveBeenCalledWith(
        "Failed to dispose late music session client",
        failure,
      )
      expect(client.disposeCalls).toBe(1)
    } finally {
      report.mockRestore()
    }
  })

  test("a factory that rejects after disposal cannot publish into the old session", async () => {
    let reject!: (error: Error) => void
    const media = createSessionSystemMedia({
      createClient: () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    })
    const events: unknown[] = []
    media.subscribe((event) => events.push(event))
    await flush()
    await media.dispose()
    reject(new Error("obsolete acquisition failed"))
    await flush()
    expect(events).toEqual([])
    await media.dispose()
  })

  test("cleanup releases every subscription and surfaces failures on repeated disposal", async () => {
    const client = new FakeClient()
    const failure = new Error("client cleanup failed")
    const unsubscribeFailure = new Error("subscription cleanup failed")
    const subscribeState = client.subscribeState.bind(client)
    client.subscribeState = (listener) => {
      const unsubscribe = subscribeState(listener)
      return () => {
        unsubscribe()
        throw unsubscribeFailure
      }
    }
    client.dispose = async () => {
      client.disposeCalls++
      throw failure
    }
    const media = createSessionSystemMedia({ createClient: async () => client })
    await flush()
    const disposal = media.dispose()
    expect(media.dispose()).toBe(disposal)
    await expect(disposal).rejects.toThrow("music session cleanup failed")
    await expect(disposal).rejects.toMatchObject({
      errors: [unsubscribeFailure, failure],
    })
    expect(client.disposeCalls).toBe(1)
    expect(client.stateListeners.size).toBe(0)
    expect(client.statusListeners.size).toBe(0)
    expect(client.connectionListeners.size).toBe(0)
  })

  test("keeps metadata cache keys separate from full identities", () => {
    const identity = {
      uid: "a",
      title: "Song",
      artist: "Artist",
      album: "Album",
      duration_ms: 180_000,
    }
    expect(artworkCacheKey(identity)).toBe(
      artworkCacheKey({ ...identity, uid: "b" }),
    )
    expect(artworkIdentityKey(identity)).not.toBe(
      artworkIdentityKey({ ...identity, uid: "b" }),
    )
  })

  test("owns one client and projects replay, replacement, and lifecycle", async () => {
    const client = new FakeClient()
    let factories = 0
    const media = createSessionSystemMedia({
      createClient: async () => {
        factories++
        return client
      },
    })
    const events: any[] = []
    media.subscribe((event) => events.push(event))
    const players = await Promise.all(
      Array.from({ length: 20 }, () => media.player()),
    )
    expect(factories).toBe(1)
    expect(players.every((player) => player?.track?.name === "one")).toBeTrue()

    client.emitConnection({
      type: "reconnecting",
      error: { message: "lost", retryable: true } as never,
    })
    client.emitState(state("replacement", 1, "daemon-b"))
    client.emitStatus({
      kind: "degraded",
      provider: "nowplaying-cli",
      message: "fallback",
    })
    expect((await media.player())?.track?.name).toBe("replacement")
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "lifecycle", message: "lost" }),
        expect.objectContaining({
          type: "snapshot",
          state: expect.objectContaining({
            track: expect.objectContaining({ name: "replacement" }),
          }),
        }),
      ]),
    )
    client.emitConnection({ type: "connected", daemonInstanceId: "daemon-b" })
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: "lifecycle", message: "fallback" }),
    )
    await media.dispose()
  })

  test("delegates controls once and routes artwork only through the client", async () => {
    const client = new FakeClient()
    client.state = state("controls")
    client.artworkResult = { type: "available", base64: "AQID" }
    const native: Array<string | null> = []
    const media = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: async (_key, _target, bytes) => {
        native.push(bytes)
        return { artwork: null, duration_ms: 180_000 }
      },
    })
    await media.player()
    await flush()
    await Promise.all([
      media.play(),
      media.pause!(),
      media.next!(),
      media.previous!(),
      media.seek!(4321),
    ])
    expect(client.calls).toEqual([
      "play",
      "pause",
      "next",
      "previous",
      "seek:4321",
    ])
    expect(client.artworkCalls).toEqual([
      expect.objectContaining({
        id: "id-controls",
        name: "controls",
        duration_ms: 180_000,
      }),
    ])
    expect(native).toEqual(["AQID"])
    await media.dispose()
  })

  test("artwork resolution never replaces daemon duration", async () => {
    const client = new FakeClient()
    client.state = {
      ...state("unknown-duration", 5),
      state: {
        ...state("unknown-duration", 5).state,
        track: {
          ...state("unknown-duration", 5).state.track!,
          duration_ms: 0,
        },
      },
    }
    const cover = { id: "cover", png_base64: "", accent: "", cells: [] }
    const media = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: async () => ({
        artwork: cover,
        duration_ms: 180_000,
      }),
    })

    expect(await media.player()).toMatchObject({
      track: { duration_ms: 0, artwork_loading: true },
    })
    await flush()
    await flush()
    expect(await media.player()).toMatchObject({
      track: { duration_ms: 0, artwork: cover, artwork_loading: false },
    })
    await media.dispose()
  })

  test("falls back for all non-available artwork results and bounds distinct jobs", async () => {
    let now = 0
    const client = new FakeClient()
    const resolved: Array<string | null> = []
    const media = createSessionSystemMedia({
      createClient: async () => client,
      now: () => now,
      resolveArtworkDetails: async (_key, target, bytes) => {
        resolved.push(bytes)
        return { artwork: null, duration_ms: target.duration_ms }
      },
    })
    for (const result of [
      { type: "unavailable" },
      { type: "stale" },
      { type: "too-large" },
    ] as ArtworkResult[]) {
      client.artworkResult = result
      client.emitState(state(`outcome-${result.type}`, ++now))
      await media.player()
      await flush()
      now += 10_000
    }
    client.artworkFailure = new Error("disconnected")
    client.emitState(state("outcome-rejected", ++now))
    await media.player()
    await flush()
    expect(resolved).toEqual([null, null, null, null])
    await media.dispose()
  })

  test("shares equal artwork work and only refresh explicitly retries a settled null", async () => {
    let now = 0
    const first = new FakeClient()
    first.state = state("shared-retry")
    const second = new FakeClient()
    second.state = state("shared-retry")
    let resolutions = 0
    const overrides = {
      now: () => now,
      resolveArtworkDetails: async (_key: string, target: any) => {
        resolutions++
        return { artwork: null, duration_ms: target.duration_ms }
      },
    }
    const backendA = createSessionSystemMedia({
      createClient: async () => first,
      ...overrides,
    })
    const backendB = createSessionSystemMedia({
      createClient: async () => second,
      ...overrides,
    })
    await Promise.all([backendA.player(), backendB.player()])
    await flush()
    expect(first.artworkCalls).toHaveLength(1)
    expect(second.artworkCalls).toHaveLength(0)
    expect(resolutions).toBe(1)
    await backendA.player()
    await flush()
    expect(first.artworkCalls).toHaveLength(1)
    now = 2_000
    await backendB.player()
    await flush()
    expect(resolutions).toBe(1)
    await backendB.refreshArtwork()
    await flush()
    expect(first.artworkCalls).toHaveLength(1)
    expect(second.artworkCalls).toHaveLength(1)
    await backendA.dispose()
    await backendB.dispose()
  })

  test("keeps detached shared work for surviving consumers", async () => {
    const first = new FakeClient()
    const second = new FakeClient()
    first.state = state("detached-shared")
    second.state = state("detached-shared")
    let release!: (result: ArtworkResult) => void
    first.artworkGate = new Promise((resolve) => {
      release = resolve
    })
    const cover = { id: "shared", png_base64: "", accent: "", cells: [] }
    const firstEvents: unknown[] = []
    const secondEvents: unknown[] = []
    const resolver = async (_key: string, target: any) => ({
      artwork: cover,
      duration_ms: target.duration_ms,
    })
    const firstMedia = createSessionSystemMedia({
      createClient: async () => first,
      resolveArtworkDetails: resolver,
    })
    const secondMedia = createSessionSystemMedia({
      createClient: async () => second,
      resolveArtworkDetails: resolver,
    })
    firstMedia.subscribePresentation((event) => firstEvents.push(event))
    secondMedia.subscribePresentation((event) => secondEvents.push(event))
    await Promise.all([firstMedia.player(), secondMedia.player()])
    await flush()
    expect(first.artworkCalls).toHaveLength(1)
    expect(second.artworkCalls).toHaveLength(0)

    await firstMedia.dispose()
    release({ type: "available", base64: "shared" })
    await flush()
    await flush()
    expect(firstEvents).toEqual([])
    expect(secondEvents).toEqual([
      expect.objectContaining({
        artwork: cover,
        identity: expect.objectContaining({ uid: "id-detached-shared" }),
      }),
    ])
    await secondMedia.dispose()
  })

  test("settled artwork uses deterministic FIFO eviction at the 32-entry boundary", async () => {
    const client = new FakeClient()
    client.state = state("eviction-0", 10)
    client.artworkResult = { type: "available", base64: "cover" }
    const media = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: async (_key, target) => ({
        artwork: { id: target.title, png_base64: "", accent: "", cells: [] },
        duration_ms: target.duration_ms,
      }),
    })
    try {
      await media.player()
      await flush()
      await flush()
      for (let index = 1; index <= 32; index++) {
        client.emitState(state(`eviction-${index}`, 10 + index))
        await flush()
        await flush()
      }
      const calls = client.artworkCalls.length
      client.emitState(state("eviction-0", 100))
      await flush()
      await flush()
      expect(client.artworkCalls).toHaveLength(calls + 1)
    } finally {
      await media.dispose()
    }
  })

  test("bounds blocked jobs and admits one deferred current identity after a slot settles", async () => {
    const clients: FakeClient[] = []
    const mediaInstances: ReturnType<typeof createSessionSystemMedia>[] = []
    const releases: Array<(result: ArtworkResult) => void> = []
    for (let index = 0; index < 33; index++) {
      const client = new FakeClient()
      client.state = state(`capacity-${index}`)
      client.artworkGate = new Promise((resolve) => releases.push(resolve))
      clients.push(client)
      const media = createSessionSystemMedia({
        createClient: async () => client,
        resolveArtworkDetails: async (_key, target) => ({
          artwork: null,
          duration_ms: target.duration_ms,
        }),
      })
      mediaInstances.push(media)
      await media.player()
    }
    try {
      await flush()
      const started = clients.filter((client) => client.artworkCalls.length > 0)
      const waiting = clients.filter(
        (client) => client.artworkCalls.length === 0,
      )
      // Other test files can own global presentation jobs, but this group
      // still fills every remaining slot and leaves a deterministic waiter.
      expect(started.length).toBeGreaterThan(0)
      expect(started.length).toBeLessThanOrEqual(32)
      expect(waiting.length).toBeGreaterThan(0)
      const released = clients.indexOf(started[0]!)
      await mediaInstances[released]!.dispose()
      await flush()
      expect(waiting[0]!.artworkCalls).toHaveLength(0)
      releases[released]!({ type: "available", base64: "released" })
      await flush()
      await flush()
      expect(waiting[0]!.artworkCalls).toHaveLength(1)
    } finally {
      await Promise.all(mediaInstances.map((media) => media.dispose()))
      for (const release of releases) release({ type: "unavailable" })
      await flush()
      await flush()
    }
    expect(clients.every((client) => client.disposeCalls === 1)).toBeTrue()
  })

  test("physical settlement admits a shared deferred identity and publishes to both waiters", async () => {
    const owners: Array<ReturnType<typeof createSessionSystemMedia>> = []
    const ownerClients: FakeClient[] = []
    const releases: Array<(result: ArtworkResult) => void> = []
    const waitA = new FakeClient()
    const waitB = new FakeClient()
    waitA.state = state("shared-deferred")
    waitB.state = state("shared-deferred")
    let releaseWaiter!: (result: ArtworkResult) => void
    waitA.artworkGate = new Promise((resolve) => {
      releaseWaiter = resolve
    })
    const cover = { id: "shared", png_base64: "", accent: "", cells: [] }
    const presentationA: unknown[] = []
    const presentationB: unknown[] = []
    try {
      for (let index = 0; index < 32; index++) {
        const client = new FakeClient()
        client.state = state(`dispose-capacity-${index}`)
        client.artworkGate = new Promise((resolve) => releases.push(resolve))
        ownerClients.push(client)
        const media = createSessionSystemMedia({
          createClient: async () => client,
          resolveArtworkDetails: async (_key, target) => ({
            artwork: null,
            duration_ms: target.duration_ms,
          }),
        })
        owners.push(media)
        await media.player()
      }
      const resolver = async (_key: string, target: any) => ({
        artwork: cover,
        duration_ms: target.duration_ms,
      })
      const deferredA = createSessionSystemMedia({
        createClient: async () => waitA,
        resolveArtworkDetails: resolver,
      })
      const deferredB = createSessionSystemMedia({
        createClient: async () => waitB,
        resolveArtworkDetails: resolver,
      })
      owners.push(deferredA, deferredB)
      deferredA.subscribePresentation((event) => presentationA.push(event))
      deferredB.subscribePresentation((event) => presentationB.push(event))
      await Promise.all([deferredA.player(), deferredB.player()])
      await flush()
      expect(waitA.artworkCalls).toHaveLength(0)
      expect(waitB.artworkCalls).toHaveLength(0)

      const firstStarted = ownerClients.findIndex(
        (client) => client.artworkCalls.length > 0,
      )
      expect(firstStarted).toBeGreaterThanOrEqual(0)
      await owners[firstStarted]!.dispose()
      await flush()
      expect(waitA.artworkCalls).toHaveLength(0)

      // A concurrently running test can have an older global deferred key.
      // Settle physical owners until this shared key is admitted.
      for (const [index, owner] of ownerClients.entries()) {
        if (owner.artworkCalls.length === 0) continue
        releases[index]!({ type: "unavailable" })
        await flush()
        await flush()
        if (waitA.artworkCalls.length > 0) break
      }
      expect(waitA.artworkCalls).toHaveLength(1)
      expect(waitB.artworkCalls).toHaveLength(0)
      releaseWaiter({ type: "available", base64: "shared" })
      await flush()
      await flush()
      expect(presentationA).toEqual([
        expect.objectContaining({
          artwork: cover,
          identity: expect.objectContaining({ uid: "id-shared-deferred" }),
        }),
      ])
      expect(presentationB).toEqual([
        expect.objectContaining({
          artwork: cover,
          identity: expect.objectContaining({ uid: "id-shared-deferred" }),
        }),
      ])
    } finally {
      await Promise.all(owners.map((media) => media.dispose()))
      for (const release of releases) release({ type: "unavailable" })
      await flush()
      await flush()
    }
  })

  test("disposing the first deferred waiter admits with the surviving waiter's client and resolver", async () => {
    const owners: Array<ReturnType<typeof createSessionSystemMedia>> = []
    const ownerClients: FakeClient[] = []
    const releases: Array<(result: ArtworkResult) => void> = []
    const first = new FakeClient()
    const second = new FakeClient()
    first.state = state("deferred-owner")
    second.state = state("deferred-owner")
    let firstResolutions = 0
    let secondResolutions = 0
    const secondEvents: unknown[] = []
    const cover = { id: "second", png_base64: "", accent: "", cells: [] }
    try {
      for (let index = 0; index < 32; index++) {
        const client = new FakeClient()
        client.state = state(`deferred-owner-capacity-${index}`)
        client.artworkGate = new Promise((resolve) => releases.push(resolve))
        ownerClients.push(client)
        const media = createSessionSystemMedia({
          createClient: async () => client,
          resolveArtworkDetails: async (_key, target) => ({
            artwork: null,
            duration_ms: target.duration_ms,
          }),
        })
        owners.push(media)
        await media.player()
      }
      const deferredFirst = createSessionSystemMedia({
        createClient: async () => first,
        resolveArtworkDetails: async (_key, target) => {
          firstResolutions++
          return { artwork: null, duration_ms: target.duration_ms }
        },
      })
      const deferredSecond = createSessionSystemMedia({
        createClient: async () => second,
        resolveArtworkDetails: async (_key, target) => {
          secondResolutions++
          return { artwork: cover, duration_ms: target.duration_ms }
        },
      })
      owners.push(deferredFirst, deferredSecond)
      deferredSecond.subscribePresentation((event) => secondEvents.push(event))
      await Promise.all([deferredFirst.player(), deferredSecond.player()])
      await flush()
      await deferredFirst.dispose()

      const firstStarted = ownerClients.findIndex(
        (client) => client.artworkCalls.length > 0,
      )
      expect(firstStarted).toBeGreaterThanOrEqual(0)
      await owners[firstStarted]!.dispose()
      await flush()
      expect(second.artworkCalls).toHaveLength(0)

      for (const [index, owner] of ownerClients.entries()) {
        if (owner.artworkCalls.length === 0) continue
        releases[index]!({ type: "unavailable" })
        await flush()
        await flush()
        if (second.artworkCalls.length > 0) break
      }
      await flush()
      expect(first.artworkCalls).toHaveLength(0)
      expect(firstResolutions).toBe(0)
      expect(second.artworkCalls).toHaveLength(1)
      expect(secondResolutions).toBe(1)
      expect(secondEvents).toEqual([
        expect.objectContaining({
          artwork: cover,
          identity: expect.objectContaining({ uid: "id-deferred-owner" }),
        }),
      ])
    } finally {
      await Promise.all(owners.map((media) => media.dispose()))
      for (const release of releases) release({ type: "unavailable" })
      await flush()
      await flush()
    }
  })

  test("deferred admission overflow settles as no-artwork instead of loading forever", async () => {
    const owners: Array<ReturnType<typeof createSessionSystemMedia>> = []
    const releases: Array<(result: ArtworkResult) => void> = []
    try {
      for (let index = 0; index < 32; index++) {
        const client = new FakeClient()
        client.state = state(`overflow-capacity-${index}`)
        client.artworkGate = new Promise((resolve) => releases.push(resolve))
        const media = createSessionSystemMedia({
          createClient: async () => client,
          resolveArtworkDetails: async (_key, target) => ({
            artwork: null,
            duration_ms: target.duration_ms,
          }),
        })
        owners.push(media)
        await media.player()
      }
      let overflow: PlayerState | null = null
      for (let index = 0; index < 33; index++) {
        const client = new FakeClient()
        client.state = state(`overflow-waiter-${index}`)
        const media = createSessionSystemMedia({
          createClient: async () => client,
          resolveArtworkDetails: async (_key, target) => ({
            artwork: null,
            duration_ms: target.duration_ms,
          }),
        })
        owners.push(media)
        overflow = await media.player()
      }
      expect(overflow?.track).toMatchObject({
        artwork: null,
        artwork_loading: false,
      })
    } finally {
      await Promise.all(owners.map((media) => media.dispose()))
      for (const release of releases) release({ type: "unavailable" })
      await flush()
      await flush()
    }
  })

  test("late A artwork completion cannot overwrite B's current presentation", async () => {
    const client = new FakeClient()
    client.state = state("A")
    let releaseA!: (result: ArtworkResult) => void
    client.artworkGate = new Promise((resolve) => {
      releaseA = resolve
    })
    let releaseResolverA!: (value: any) => void
    const coverB = { id: "B", png_base64: "", accent: "", cells: [] }
    const presentations: unknown[] = []
    const media = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: async (_key, target, bytes) =>
        bytes === "A"
          ? new Promise((resolve) => {
              releaseResolverA = resolve
            })
          : { artwork: coverB, duration_ms: target.duration_ms },
    })
    media.subscribePresentation((event) => presentations.push(event))
    await media.player()
    await flush()
    client.artworkGate = undefined
    client.artworkResult = { type: "available", base64: "B" }
    client.emitState(state("B"))
    await flush()
    await flush()
    expect((await media.player())?.track?.artwork).toBe(coverB)
    releaseA({ type: "available", base64: "A" })
    await flush()
    releaseResolverA({
      artwork: { id: "A", png_base64: "", accent: "", cells: [] },
      duration_ms: 180_000,
    })
    await flush()
    expect((await media.player())?.track).toMatchObject({
      id: "id-B",
      artwork: coverB,
    })
    expect(presentations).toEqual([
      expect.objectContaining({
        artwork: coverB,
        identity: expect.objectContaining({ uid: "id-B" }),
      }),
    ])
    await media.dispose()
  })

  test("disposal closes exactly one client and fences late state, artwork, and listeners", async () => {
    const client = new FakeClient()
    client.state = state("disposal")
    let releaseArtwork!: (result: ArtworkResult) => void
    client.artworkGate = new Promise((resolve) => {
      releaseArtwork = resolve
    })
    let resolverCalls = 0
    const media = createSessionSystemMedia({
      createClient: async () => client,
      resolveArtworkDetails: async () => {
        resolverCalls++
        return { artwork: null, duration_ms: 180_000 }
      },
    })
    const events: unknown[] = []
    media.subscribe((event) => events.push(event))
    await media.player()
    await flush()
    const presentations: unknown[] = []
    media.subscribePresentation((event) => presentations.push(event))
    const first = media.dispose()
    const second = media.dispose()
    releaseArtwork({ type: "available", base64: "late" })
    client.emitState(state("late", 2))
    await first
    await flush()
    expect(second).toBe(first)
    expect(client.disposeCalls).toBe(1)
    expect(client.stateListeners.size).toBe(0)
    expect(client.statusListeners.size).toBe(0)
    expect(client.connectionListeners.size).toBe(0)
    expect(presentations).toEqual([])
    expect(resolverCalls).toBe(1)
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: expect.objectContaining({
            track: expect.objectContaining({ name: "late" }),
          }),
        }),
      ]),
    )
  })
})
