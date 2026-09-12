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
  abort: AbortController
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
export type SessionClientFactory = (
  signal?: AbortSignal,
) => Promise<ReconnectingMusicSessionClient>
export type SessionSystemMediaOverrides = {
  readonly createClient?: SessionClientFactory
  readonly resolveArtworkDetails?: ArtworkResolver
  readonly now?: () => number
}

let sessionClientSequence = 0
const createOpenCodeSessionClient: SessionClientFactory = (signal) =>
  createReconnectingMusicSessionClient({
    clientId: `opencode-music-player-${++sessionClientSequence}`,
    hostKind: "opencode",
    capabilities: [...baselineCapabilities],
    ...(signal ? { signal } : {}),
  })

type PresentationHost = {
  publish: (event: ArtworkCompletionEvent) => void
  isActive: () => boolean
  accepts: (identity: ArtworkIdentity) => boolean
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
    if (!host.isActive() || !host.accepts(identity)) continue
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
  for (const entry of artworkCache.values()) entry.interests.delete(host)
  // A host owns only its interest. The physical job keeps its slot until it settles.
  for (const entry of artworkJobs.values()) {
    entry.interests.delete(host)
    if (!entry.interests.size) entry.abort.abort()
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
  let entry = artworkJobs.get(key) ?? artworkCache.get(key)
  if (entry?.abort.signal.aborted) entry = undefined
  if (!entry) {
    if (artworkJobs.has(key) || artworkJobs.size >= MAX_ARTWORK_ENTRIES) {
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
      abort: new AbortController(),
      interests: new Map(),
    }
  }
  // A state change that reached admission supersedes any older deferred
  // identity owned by this adapter generation.
  removeWaitingInterest(host)
  if (!entry.pending && !entry.resolved) {
    entry.pending = true
    artworkJobs.set(key, entry)
    const activeEntry = entry
    void (async () => {
      let data: string | null = null
      try {
        data = await native()
      } catch {
        // Session artwork failure is transient; host catalog fallback remains.
      }
      return resolver(
        key,
        target,
        data,
        legacyKey,
        undefined,
        activeEntry.abort.signal,
      )
    })().then(
      (resolution) => {
        activeEntry.value = resolution.artwork
        activeEntry.duration_ms = resolution.duration_ms
        activeEntry.resolved = true
        activeEntry.pending = false
        if (activeEntry.abort.signal.aborted) {
          releaseArtworkSlot(key)
          return
        }
        settleArtworkEntry(key, activeEntry)
        publishArtworkCompletion(activeEntry, resolution.artwork)
      },
      () => {
        activeEntry.value = null
        activeEntry.resolved = true
        activeEntry.pending = false
        if (activeEntry.abort.signal.aborted) {
          releaseArtworkSlot(key)
          return
        }
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
  const acquisitionAbort = new AbortController()
  let disposed = false
  let currentArtworkIdentity: string | null = null
  let currentArtworkKey: string | null = null
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

  const releaseClient = async (next: ReconnectingMusicSessionClient) => {
    if (clientReleased) return
    clientReleased = true
    await next.dispose()
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
    accepts: (identity) =>
      currentArtworkIdentity === artworkIdentityKey(identity),
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
    const nextKey = state?.state.track
      ? artworkCacheKey(identityFromTrack(state.state.track))
      : null
    if (nextKey !== currentArtworkKey) removeArtworkInterests(host)
    currentArtworkKey = nextKey
    if (!state) {
      currentArtworkIdentity = null
      return null
    }
    if (!state.state.track) {
      currentArtworkIdentity = null
      return state.state as PlayerState
    }
    const track = state.state.track
    const identity = identityFromTrack(track)
    currentArtworkIdentity = artworkIdentityKey(identity)
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
        return active === client && result.type === "available"
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
    .then(() => factory(acquisitionAbort.signal))
    .then((next) => {
      if (disposed) {
        void releaseClient(next).catch((error) => {
          console.error("Failed to dispose late music session client", error)
        })
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
    async refreshArtwork() {
      await activeClient()
      const track = latest?.state.track
      if (!track) return
      const key = artworkCacheKey(identityFromTrack(track))
      // Repeated refreshes join active work; no new slot or retry budget.
      if (artworkJobs.has(key)) return
      artworkCache.delete(key)
      emit({ type: "snapshot", state: project(latest)! })
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
      disposal = Promise.resolve().then(async () => {
        const errors: unknown[] = []
        for (const unsubscribe of unsubscribers.splice(0)) {
          try {
            unsubscribe()
          } catch (error) {
            errors.push(error)
          }
        }
        listeners.clear()
        presentationListeners.clear()
        removeArtworkInterests(host)
        // Acquisition is cooperative. A late client is released by its callback.
        if (client) {
          try {
            await releaseClient(client)
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length)
          throw new AggregateError(errors, "music session cleanup failed")
      })
      acquisitionAbort.abort()
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
