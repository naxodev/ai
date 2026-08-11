/**
 * OpenCode system-media facade: core sampling/transport + host artwork enrichment.
 */
import {
  createSystemMedia as createSystemMediaCore,
  run as defaultRun,
  type CommandResult,
  type SystemMediaDependencies,
} from "@naxodev/music-core"
import { resolveArtworkDetails } from "./artwork.ts"
import type {
  Artwork,
  ArtworkCompletionEvent,
  ArtworkIdentity,
  ArtworkPresentationListener,
  MusicBackend,
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
  interests: Map<PresentationHost, ArtworkIdentity>
}
const artworkCache = new Map<string, ArtworkCacheEntry>()
const artworkJobs = new Map<string, ArtworkCacheEntry>()

type ArtworkResolver = typeof resolveArtworkDetails
export type SystemMediaOverrides = Partial<SystemMediaDependencies> & {
  resolveArtworkDetails?: ArtworkResolver
}

type PresentationHost = {
  publish: (event: ArtworkCompletionEvent) => void
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
      interests: new Map(),
    }
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
    void (async () => {
      const data = await native?.()
      return resolver(key, target, data ?? null, legacyKey)
    })().then(
      (resolution) => {
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

export function openNowPlayingApp() {
  Bun.spawn(["open", "https://music.youtube.com"], {
    stdout: "ignore",
    stderr: "ignore",
  })
}
