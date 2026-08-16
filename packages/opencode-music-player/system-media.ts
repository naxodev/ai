/**
 * OpenCode system-media facade: core sampling/transport + host artwork enrichment.
 */
import {
  baselineCapabilities,
  createReconnectingMusicSessionClient,
  createSystemMedia as createSystemMediaCore,
  run as defaultRun,
  type ArtworkIdentity as SessionArtworkIdentity,
  type ArtworkResult as SessionArtworkResult,
  type CommandResult,
  type MusicSessionConnectionLifecycle,
  type ProviderStatus,
  type ReconnectingMusicSessionClient,
  type RevisionedState,
  type SystemMediaDependencies,
} from "@naxodev/music-core"
import { resolveArtworkDetails } from "./artwork.ts"
import type {
  Artwork,
  ArtworkCompletionEvent,
  ArtworkIdentity,
  ArtworkPresentationListener,
  MusicBackend,
  MusicChangeEvent,
  MusicError,
  PlayerState,
} from "./types.ts"

type MediaGet = {
  title?: string | null
  artist?: string | null
  album?: string | null
  duration?: number | null
  contentItemIdentifier?: string | null
  artworkData?: string | null
}

type ArtworkCacheEntry = {
  value: Artwork | null
  duration_ms: number
  resolved: boolean
  pending: boolean
  attempts: number
  retry_at: number
  /** The adapter/direct facade that last owned this entry's native work. */
  owner: PresentationHost | null
  interests: Map<PresentationHost, ArtworkIdentity>
}
const artworkCache = new Map<string, ArtworkCacheEntry>()
const artworkJobs = new Map<string, ArtworkCacheEntry>()

type ArtworkResolver = typeof resolveArtworkDetails
export type SystemMediaOverrides = Partial<SystemMediaDependencies> & {
  resolveArtworkDetails?: ArtworkResolver
}

/** Public-contract-only seam for the Phase 8 session adapter. */
export type SessionClientFactory = () => Promise<ReconnectingMusicSessionClient>
export type SessionSystemMediaOverrides = {
  readonly createClient?: SessionClientFactory
  readonly resolveArtworkDetails?: ArtworkResolver
  readonly now?: () => number
}

let sessionClientSequence = 0
const createOpenCodeSessionClient: SessionClientFactory = () =>
  createReconnectingMusicSessionClient({
    // One adapter owns one stable client ID; another adapter must not share it.
    clientId: `opencode-music-player-${++sessionClientSequence}`,
    hostKind: "opencode",
    capabilities: [...baselineCapabilities],
  })

type PresentationHost = {
  publish: (event: ArtworkCompletionEvent) => void
  /** Reject completion from an adapter generation released while work ran. */
  isActive: () => boolean
}

export type { CommandResult }
export {
  bundleLabel,
  hasMediaControl,
  hasNowPlayingCli,
  liveFromClock,
  run,
  trackKey,
} from "@naxodev/music-core"

export function artworkIdentityKey(identity: ArtworkIdentity): string {
  return JSON.stringify([
    identity.uid,
    identity.title,
    identity.artist,
    identity.album,
    identity.duration_ms,
  ])
}

/** Cache covers by recording metadata; provider IDs can change on pause. */
export function artworkCacheKey(identity: ArtworkIdentity): string {
  return JSON.stringify([
    identity.title,
    identity.artist,
    identity.album,
    identity.duration_ms,
  ])
}

function artworkIdentityFromSample(sample: MediaGet): ArtworkIdentity | null {
  if (!sample.title) return null
  const duration =
    typeof sample.duration === "number" && Number.isFinite(sample.duration)
      ? sample.duration
      : 0
  return {
    uid:
      sample.contentItemIdentifier != null
        ? String(sample.contentItemIdentifier)
        : "",
    title: String(sample.title),
    artist: sample.artist != null ? String(sample.artist) : "",
    album: sample.album != null ? String(sample.album) : "",
    duration_ms: Math.round(duration * 1_000),
  }
}

export function artworkDataForIdentity(
  expected: ArtworkIdentity,
  sample: MediaGet,
): string | null {
  const actual = artworkIdentityFromSample(sample)
  if (
    !actual ||
    artworkIdentityKey(actual) !== artworkIdentityKey(expected) ||
    typeof sample.artworkData !== "string" ||
    !sample.artworkData
  ) {
    return null
  }
  return sample.artworkData
}

function identityFromTrack(track: {
  id: string
  name: string
  artists: string
  album: string
  duration_ms: number
}): ArtworkIdentity {
  return {
    uid: track.id,
    title: track.name,
    artist: track.artists,
    album: track.album,
    duration_ms: track.duration_ms,
  }
}

function artworkForTrack(
  key: string,
  legacyKey: string,
  target: {
    title: string
    artist: string
    album: string
    duration_ms: number
  },
  native: (() => Promise<string | null>) | null,
  resolver: ArtworkResolver,
  host: PresentationHost,
  identity: ArtworkIdentity,
  now: () => number,
): { artwork: Artwork | null; duration_ms: number; loading: boolean } {
  let entry = artworkCache.get(key) ?? artworkJobs.get(key)
  if (!entry) {
    entry = {
      value: null,
      duration_ms: target.duration_ms,
      resolved: false,
      pending: false,
      attempts: 0,
      retry_at: 0,
      owner: null,
      interests: new Map(),
    }
  }

  // A released session adapter cannot own a cache mutation. A current host
  // replacing it starts its own request instead of inheriting stale bytes.
  if (entry.pending && entry.owner && !entry.owner.isActive()) {
    entry.pending = false
    entry.owner = null
    artworkJobs.delete(key)
  }

  if (
    !entry.pending &&
    entry.attempts < 3 &&
    now() >= entry.retry_at &&
    (!entry.resolved || entry.value === null)
  ) {
    entry.pending = true
    entry.attempts++
    artworkJobs.set(key, entry)
    const activeEntry = entry
    const activeHost = host
    activeEntry.owner = activeHost
    void (async () => {
      // A session disconnect/artwork rejection is transient host artwork
      // failure: retain the catalog fallback rather than caching the error.
      let data: string | null | undefined
      try {
        data = await native?.()
      } catch {
        data = null
      }
      // Do not start host-local fallback work after this adapter generation
      // released the native request.
      if (!activeHost.isActive() || activeEntry.owner !== activeHost) {
        return { artwork: null, duration_ms: activeEntry.duration_ms }
      }
      return resolver(key, target, data ?? null, legacyKey)
    })().then(
      (resolution) => {
        if (!activeHost.isActive() || activeEntry.owner !== activeHost) return
        activeEntry.value = resolution.artwork
        activeEntry.duration_ms = resolution.duration_ms
        activeEntry.resolved = true
        activeEntry.pending = false
        if (!resolution.artwork) {
          activeEntry.retry_at = now() + 2_000 * 2 ** (activeEntry.attempts - 1)
        }
        settleArtworkEntry(key, activeEntry)
        publishArtworkCompletion(activeEntry, resolution.artwork)
      },
      () => {
        if (!activeHost.isActive() || activeEntry.owner !== activeHost) return
        activeEntry.value = null
        activeEntry.resolved = true
        activeEntry.pending = false
        activeEntry.retry_at = now() + 2_000 * 2 ** (activeEntry.attempts - 1)
        settleArtworkEntry(key, activeEntry)
        publishArtworkCompletion(activeEntry, null)
      },
    )
  }
  if (entry.pending) entry.interests.set(host, identity)
  return {
    artwork: entry.value,
    duration_ms: entry.duration_ms,
    loading: entry.pending,
  }
}

function settleArtworkEntry(key: string, entry: ArtworkCacheEntry) {
  artworkJobs.delete(key)
  artworkCache.set(key, entry)
  if (artworkCache.size > 32) {
    const oldest = artworkCache.keys().next().value
    if (oldest) artworkCache.delete(oldest)
  }
}

function removeArtworkInterests(host: PresentationHost) {
  for (const [key, entry] of artworkCache) {
    entry.interests.delete(host)
    if (entry.owner !== host || entry.pending) continue
    // Successful covers are shared presentation data. A released worker must
    // not evict a later controller's cache hit; null/failure retry state is
    // generation-owned and must start fresh for a replacement.
    if (entry.value === null) artworkCache.delete(key)
    else entry.owner = null
  }
  for (const [key, entry] of artworkJobs) {
    entry.interests.delete(host)
    if (entry.owner !== host) continue
    // A released session generation cannot retain a pending job or its retry
    // budget for a later adapter generation.
    entry.pending = false
    entry.owner = null
    artworkJobs.delete(key)
    if (artworkCache.get(key) === entry && entry.value === null)
      artworkCache.delete(key)
  }
}

function publishArtworkCompletion(
  entry: ArtworkCacheEntry,
  artwork: Artwork | null,
) {
  for (const [host, identity] of entry.interests) {
    host.publish({
      type: "artwork-completion",
      identity,
      artwork,
      duration_ms: entry.duration_ms,
    })
  }
  entry.interests.clear()
}

export function createSystemMedia(
  overrides: SystemMediaOverrides = {},
): MusicBackend {
  const {
    resolveArtworkDetails: resolver = resolveArtworkDetails,
    ...coreOverrides
  } = overrides
  const core = createSystemMediaCore(coreOverrides)
  const { subscribe: coreSubscribe, ...coreBackend } = core
  const runCmd = overrides.run ?? defaultRun
  const now = overrides.now ?? Date.now
  const presentationListeners = new Set<ArtworkPresentationListener>()
  const host: PresentationHost = {
    publish(event) {
      for (const listener of presentationListeners) listener(event)
    },
    isActive: () => true,
  }

  const projectPlayer = (state: Awaited<ReturnType<typeof core.player>>) => {
    if (!state?.track) return state as PlayerState | null

    const track = state.track
    const identity = identityFromTrack(track)
    const artworkState = artworkForTrack(
      artworkCacheKey(identity),
      artworkIdentityKey(identity),
      {
        title: track.name,
        artist: track.artists,
        album: track.album,
        duration_ms: track.duration_ms,
      },
      async () => {
        const result = await runCmd(["media-control", "get", "--now"])
        if (!result.ok) return null
        try {
          const sample = JSON.parse(result.out) as MediaGet | null
          return sample ? artworkDataForIdentity(identity, sample) : null
        } catch {
          return null
        }
      },
      resolver,
      host,
      identity,
      now,
    )
    return {
      ...state,
      track: {
        ...track,
        duration_ms:
          track.duration_ms > 0 ? track.duration_ms : artworkState.duration_ms,
        artwork: artworkState.artwork,
        artwork_loading: artworkState.loading,
      },
    } satisfies PlayerState
  }

  const backend: MusicBackend = {
    ...coreBackend,
    async player(): Promise<PlayerState | null> {
      return projectPlayer(await core.player())
    },

    async searchTracks(): Promise<never> {
      throw {
        status: 501,
        message: "Search in the app that's playing",
      } satisfies MusicError
    },
  }
  if (coreSubscribe) {
    backend.subscribe = (listener) => {
      let disposed = false
      const disposeCore = coreSubscribe((event) => {
        if (disposed || !event) {
          if (!disposed) listener()
          return
        }
        if (event.type === "invalidation") {
          if (!disposed && event?.type === "invalidation") {
            listener({ type: "invalidation", reason: event.reason })
          }
          return
        }
        listener({ type: "snapshot", state: projectPlayer(event.state)! })
      })
      return () => {
        if (disposed) return
        disposed = true
        disposeCore()
      }
    }
  }
  backend.subscribePresentation = (listener) => {
    let disposed = false
    presentationListeners.add(listener)
    return () => {
      if (disposed) return
      disposed = true
      presentationListeners.delete(listener)
    }
  }
  return backend
}

/**
 * OpenCode projection over one reconnecting core client. It deliberately owns
 * no provider probing, polling, playback clock, or command queue.
 */
export function createSessionSystemMedia(
  overrides: SessionSystemMediaOverrides = {},
): MusicBackend {
  const factory = overrides.createClient ?? createOpenCodeSessionClient
  const resolver = overrides.resolveArtworkDetails ?? resolveArtworkDetails
  const now = overrides.now ?? Date.now
  const listeners = new Set<(event?: MusicChangeEvent) => void>()
  const presentationListeners = new Set<ArtworkPresentationListener>()
  let disposed = false
  let client: ReconnectingMusicSessionClient | undefined
  let installed = false
  let latest: RevisionedState | undefined
  let latestStatus: ProviderStatus | undefined
  let latestConnection: MusicSessionConnectionLifecycle | undefined
  let acquisitionError: string | undefined
  let publishedLifecycle: string | null | undefined
  let unsubscribers: Array<() => void> = []
  let clientReleased = false
  let disposal: Promise<void> | undefined
  const releaseClient = (next: ReconnectingMusicSessionClient) => {
    if (clientReleased) return Promise.resolve()
    clientReleased = true
    return Promise.resolve(next.dispose()).catch(() => {})
  }

  const emit = (event?: MusicChangeEvent) => {
    if (disposed) return
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // A host observer cannot prevent another observer from receiving state.
      }
    }
  }
  const host: PresentationHost = {
    publish(event) {
      if (disposed) return
      for (const listener of [...presentationListeners]) {
        try {
          listener(event)
        } catch {
          // Presentation observers are isolated like state observers.
        }
      }
    },
    isActive: () => !disposed,
  }
  const lifecycleMessage = () => {
    // A connection loss/terminal is actionable and takes precedence over a
    // concurrently replayed ready provider. Once reconnected, provider status
    // again owns the message (for example, a degraded fallback).
    if (
      latestConnection?.type === "reconnecting" ||
      latestConnection?.type === "terminal"
    )
      return latestConnection.error.message
    if (latestConnection?.type === "disposed")
      return "music session is disposed"
    if (acquisitionError) return acquisitionError
    return latestStatus && latestStatus.kind !== "ready"
      ? latestStatus.message
      : null
  }
  const publishLifecycle = (force = false) => {
    const message = lifecycleMessage()
    if (!force && publishedLifecycle === message) return
    publishedLifecycle = message
    emit({ type: "lifecycle", message })
  }
  const project = (state: RevisionedState | undefined): PlayerState | null => {
    if (!state) return null
    if (!state.state.track) return state.state as PlayerState
    const track = state.state.track
    const identity = identityFromTrack(track)
    const artworkState = artworkForTrack(
      artworkCacheKey(identity),
      artworkIdentityKey(identity),
      {
        title: track.name,
        artist: track.artists,
        album: track.album,
        duration_ms: track.duration_ms,
      },
      async () => {
        const active = await clientPromise
        if (disposed || active !== client) return null
        const result: SessionArtworkResult = await active.artwork({
          id: track.id,
          name: track.name,
          artists: track.artists,
          album: track.album,
          duration_ms: track.duration_ms,
        } satisfies SessionArtworkIdentity)
        return !disposed && active === client && result.type === "available"
          ? result.base64
          : null
      },
      resolver,
      host,
      identity,
      now,
    )
    return {
      ...state.state,
      track: {
        ...track,
        duration_ms:
          track.duration_ms > 0 ? track.duration_ms : artworkState.duration_ms,
        artwork: artworkState.artwork,
        artwork_loading: artworkState.loading,
      },
    }
  }
  const install = (next: ReconnectingMusicSessionClient) => {
    if (installed) return
    installed = true
    client = next
    latest = next.state
    latestStatus = next.status
    latestConnection = next.connection
    unsubscribers = [
      next.subscribeState((state) => {
        if (disposed) return
        latest = state
        emit({ type: "snapshot", state: project(state)! })
      }),
      next.subscribeStatus((status) => {
        if (disposed) return
        latestStatus = status
        publishLifecycle()
      }),
      next.subscribeConnection((connection) => {
        if (disposed) return
        latestConnection = connection
        publishLifecycle()
      }),
    ]
  }
  const clientPromise = Promise.resolve()
    .then(factory)
    .then((next) => {
      if (disposed) {
        void releaseClient(next)
        return next
      }
      install(next)
      return next
    })
  // Observe acquisition once at adapter ownership; individual subscribers
  // must not turn one rejected factory into N broadcasts.
  void clientPromise.catch((error) => {
    if (disposed) return
    acquisitionError = error instanceof Error ? error.message : String(error)
    publishLifecycle()
  })
  const activeClient = async () => {
    const next = await clientPromise
    if (disposed || next !== client)
      throw new Error("music session is disposed")
    return next
  }

  return {
    id: "music-session",
    label: "System media",
    remoteControl: true,
    authenticated: () => true,
    async player() {
      await activeClient()
      return project(latest)
    },
    async searchTracks(): Promise<never> {
      throw {
        status: 501,
        message: "Search in the app that's playing",
      } satisfies MusicError
    },
    async play() {
      await (await activeClient()).play()
    },
    async pause() {
      await (await activeClient()).pause()
    },
    async next() {
      await (await activeClient()).next()
    },
    async previous() {
      await (await activeClient()).previous()
    },
    async seek(positionMs) {
      await (await activeClient()).seek(positionMs)
    },
    subscribe(listener) {
      if (disposed) return () => {}
      let closed = false
      listeners.add(listener)
      // Public-client replay may have occurred before this backend observer
      // subscribed. Replay the retained host projection exactly once.
      try {
        if (latest) listener({ type: "snapshot", state: project(latest)! })
        if (installed || acquisitionError)
          listener({ type: "lifecycle", message: lifecycleMessage() })
      } catch {
        // A replay observer is isolated like a live observer.
      }
      return () => {
        if (closed) return
        closed = true
        listeners.delete(listener)
      }
    },
    subscribePresentation(listener) {
      if (disposed) return () => {}
      let closed = false
      presentationListeners.add(listener)
      return () => {
        if (closed) return
        closed = true
        presentationListeners.delete(listener)
      }
    },
    dispose() {
      if (disposal) return disposal
      disposed = true
      for (const unsubscribe of unsubscribers.splice(0)) {
        try {
          unsubscribe()
        } catch {}
      }
      listeners.clear()
      presentationListeners.clear()
      removeArtworkInterests(host)
      disposal = clientPromise.then(
        (next) => releaseClient(next),
        () => undefined,
      )
      return disposal
    },
  }
}

export function openNowPlayingApp() {
  Bun.spawn(["open", "https://music.youtube.com"], {
    stdout: "ignore",
    stderr: "ignore",
  })
}
