/** OpenCode session facade plus host-local artwork presentation. */
import {
  baselineCapabilities,
  createReconnectingMusicSessionClient,
  type ArtworkIdentity as SessionArtworkIdentity,
  type ArtworkResult as SessionArtworkResult,
  type CommandResult,
  type MusicSessionConnectionLifecycle,
  type ProviderStatus,
  type ReconnectingMusicSessionClient,
  type RevisionedState,
} from "@naxodev/music-core"
import { resolveArtworkDetails } from "./artwork.ts"
import type {
  Artwork,
  ArtworkCompletionEvent,
  ArtworkIdentity,
  ArtworkPresentationListener,
  SessionMedia,
  SessionMediaEvent,
  SessionMediaLifecycleEvent,
  PlayerState,
} from "./types.ts"

type ArtworkCacheEntry = {
  value: Artwork | null
  duration_ms: number
  resolved: boolean
  pending: boolean
  attempts: number
  retry_at: number
  owner: PresentationHost | null
  interests: Map<PresentationHost, ArtworkIdentity>
}
const MAX_ARTWORK_ENTRIES = 32
const artworkCache = new Map<string, ArtworkCacheEntry>()
const artworkJobs = new Map<string, ArtworkCacheEntry>()
type DeferredArtworkInterest = {
  legacyKey: string
  target: { title: string; artist: string; album: string; duration_ms: number }
  native: () => Promise<string | null>
  resolver: ArtworkResolver
  host: PresentationHost
  identity: ArtworkIdentity
  now: () => number
}
type DeferredArtwork = {
  interests: Map<PresentationHost, DeferredArtworkInterest>
}
// Deferred admissions are keyed by work, not host. This shares one eventual
// native/catalog request between views and bounds retained deferred work.
const waitingArtwork = new Map<string, DeferredArtwork>()
type ArtworkResolver = typeof resolveArtworkDetails

/** Public-contract-only seam for the reconnecting session adapter. */
export type SessionClientFactory = () => Promise<ReconnectingMusicSessionClient>
export type SessionSystemMediaOverrides = {
  readonly createClient?: SessionClientFactory
  readonly resolveArtworkDetails?: ArtworkResolver
  readonly now?: () => number
}

let sessionClientSequence = 0
const createOpenCodeSessionClient: SessionClientFactory = () =>
  createReconnectingMusicSessionClient({
    clientId: `opencode-music-player-${++sessionClientSequence}`,
    hostKind: "opencode",
    capabilities: [...baselineCapabilities],
  })

type PresentationHost = {
  publish: (event: ArtworkCompletionEvent) => void
  isActive: () => boolean
}

export type { CommandResult }

export function artworkIdentityKey(identity: ArtworkIdentity): string {
  return JSON.stringify([
    identity.uid,
    identity.title,
    identity.artist,
    identity.album,
    identity.duration_ms,
  ])
}

/** Cache covers by recording metadata; volatile provider IDs remain valid. */
export function artworkCacheKey(identity: ArtworkIdentity): string {
  return JSON.stringify([
    identity.title,
    identity.artist,
    identity.album,
    identity.duration_ms,
  ])
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

function removeWaitingInterest(host: PresentationHost) {
  for (const [key, deferred] of waitingArtwork) {
    deferred.interests.delete(host)
    if (deferred.interests.size === 0) waitingArtwork.delete(key)
  }
}

function admitDeferredArtwork() {
  const next = waitingArtwork.entries().next().value as
    [string, DeferredArtwork] | undefined
  if (!next) return
  const [key, deferred] = next
  waitingArtwork.delete(key)
  for (const host of deferred.interests.keys()) {
    if (!host.isActive()) deferred.interests.delete(host)
  }
  const leader = deferred.interests.values().next().value as
    DeferredArtworkInterest | undefined
  if (!leader) {
    admitDeferredArtwork()
    return
  }
  artworkForTrack(
    key,
    leader.legacyKey,
    leader.target,
    leader.native,
    leader.resolver,
    leader.host,
    leader.identity,
    leader.now,
  )
  const admitted = artworkJobs.get(key)
  if (!admitted) return
  for (const interest of deferred.interests.values()) {
    if (interest.host.isActive())
      admitted.interests.set(interest.host, interest.identity)
  }
}

function releaseArtworkSlot(key: string, entry?: ArtworkCacheEntry) {
  artworkJobs.delete(key)
  if (entry) {
    artworkCache.set(key, entry)
    if (artworkCache.size > MAX_ARTWORK_ENTRIES) {
      const oldest = artworkCache.keys().next().value
      if (oldest) artworkCache.delete(oldest)
    }
  }
  admitDeferredArtwork()
}

function settleArtworkEntry(key: string, entry: ArtworkCacheEntry) {
  releaseArtworkSlot(key, entry)
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

function removeArtworkInterests(host: PresentationHost) {
  removeWaitingInterest(host)
  for (const [key, entry] of artworkCache) {
    entry.interests.delete(host)
    if (entry.owner !== host || entry.pending) continue
    if (entry.value === null) artworkCache.delete(key)
    else entry.owner = null
  }
  for (const [key, entry] of artworkJobs) {
    entry.interests.delete(host)
    if (entry.owner !== host) continue
    entry.pending = false
    entry.owner = null
    if (artworkCache.get(key) === entry && entry.value === null)
      artworkCache.delete(key)
    // Disposal/cancellation frees a slot too. A deferred current identity
    // must be admitted even when its predecessor never resolves.
    releaseArtworkSlot(key)
  }
}

function artworkForTrack(
  key: string,
  legacyKey: string,
  target: { title: string; artist: string; album: string; duration_ms: number },
  native: () => Promise<string | null>,
  resolver: ArtworkResolver,
  host: PresentationHost,
  identity: ArtworkIdentity,
  now: () => number,
): { artwork: Artwork | null; duration_ms: number; loading: boolean } {
  let entry = artworkCache.get(key) ?? artworkJobs.get(key)
  if (!entry) {
    if (artworkJobs.size >= MAX_ARTWORK_ENTRIES) {
      removeWaitingInterest(host)
      let deferred = waitingArtwork.get(key)
      if (!deferred && waitingArtwork.size < MAX_ARTWORK_ENTRIES) {
        deferred = { interests: new Map() }
        waitingArtwork.set(key, deferred)
      }
      if (deferred && deferred.interests.size < MAX_ARTWORK_ENTRIES)
        deferred.interests.set(host, {
          legacyKey,
          target,
          native,
          resolver,
          host,
          identity,
          now,
        })
      // Overflow is deliberately stable: no additional host/job is retained
      // and the unchanged track renders as a settled no-artwork result rather
      // than a permanent loading indicator in the no-poll session model.
      return {
        artwork: null,
        duration_ms: target.duration_ms,
        loading: !!deferred && deferred.interests.has(host),
      }
    }
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
  // A state change that reached admission supersedes any older deferred
  // identity owned by this adapter generation.
  removeWaitingInterest(host)
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
      let data: string | null = null
      try {
        data = await native()
      } catch {
        // Session artwork failure is transient; host catalog fallback remains.
      }
      if (!activeHost.isActive() || activeEntry.owner !== activeHost)
        return { artwork: null, duration_ms: activeEntry.duration_ms }
      return resolver(key, target, data, legacyKey)
    })().then(
      (resolution) => {
        if (!activeHost.isActive() || activeEntry.owner !== activeHost) return
        activeEntry.value = resolution.artwork
        activeEntry.duration_ms = resolution.duration_ms
        activeEntry.resolved = true
        activeEntry.pending = false
        if (!resolution.artwork)
          activeEntry.retry_at = now() + 2_000 * 2 ** (activeEntry.attempts - 1)
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

/**
 * OpenCode projection over one reconnecting core client. It owns no provider
 * probing, native process execution, polling, playback clock, or command queue.
 */
export function createSessionSystemMedia(
  overrides: SessionSystemMediaOverrides = {},
): SessionMedia {
  const factory = overrides.createClient ?? createOpenCodeSessionClient
  const resolver = overrides.resolveArtworkDetails ?? resolveArtworkDetails
  const now = overrides.now ?? Date.now
  const listeners = new Set<(event: SessionMediaEvent) => void>()
  const presentationListeners = new Set<ArtworkPresentationListener>()
  let disposed = false
  let client: ReconnectingMusicSessionClient | undefined
  let installed = false
  let latest: RevisionedState | undefined
  let latestStatus: ProviderStatus | undefined
  let latestConnection: MusicSessionConnectionLifecycle | undefined
  let acquisitionError: string | undefined
  let publishedLifecycle: string | undefined
  let unsubscribers: Array<() => void> = []
  let clientReleased = false
  let disposal: Promise<void> | undefined

  const releaseClient = (next: ReconnectingMusicSessionClient) => {
    if (clientReleased) return Promise.resolve()
    clientReleased = true
    return Promise.resolve(next.dispose()).catch(() => {})
  }
  const emit = (event: SessionMediaEvent) => {
    if (disposed) return
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // One host observer cannot block another.
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
          // One presentation observer cannot block another.
        }
      }
    },
    isActive: () => !disposed,
  }
  const lifecycle = (): SessionMediaLifecycleEvent => {
    if (
      latestConnection?.type === "reconnecting" ||
      latestConnection?.type === "terminal"
    )
      return {
        type: "lifecycle",
        message: latestConnection.error.message,
        source: "connection",
      }
    if (latestConnection?.type === "disposed")
      return {
        type: "lifecycle",
        message: "music session is disposed",
        source: "connection",
      }
    if (acquisitionError)
      return {
        type: "lifecycle",
        message: acquisitionError,
        source: "acquisition",
      }
    return {
      type: "lifecycle",
      message:
        latestStatus && latestStatus.kind !== "ready"
          ? latestStatus.message
          : null,
      source: "provider",
    }
  }
  const publishLifecycle = () => {
    const event = lifecycle()
    const key = `${event.source}:${event.message}`
    if (publishedLifecycle === key) return
    publishedLifecycle = key
    emit(event)
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
    async player() {
      await activeClient()
      return project(latest)
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
      try {
        if (latest) listener({ type: "snapshot", state: project(latest)! })
        if (installed || acquisitionError) listener(lifecycle())
      } catch {
        // Replay is observer-isolated too.
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
