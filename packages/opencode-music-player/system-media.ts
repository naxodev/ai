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
import type { Artwork, MusicBackend, MusicError, PlayerState } from "./types.ts"

type MediaGet = {
  title?: string | null
  artist?: string | null
  album?: string | null
  duration?: number | null
  contentItemIdentifier?: string | null
  artworkData?: string | null
}

export type ArtworkIdentity = {
  uid: string
  title: string
  artist: string
  album: string
  duration_ms: number
}

type ArtworkCacheEntry = {
  value: Artwork | null
  duration_ms: number
  pending: boolean
  attempts: number
  retry_at: number
}
const artworkCache = new Map<string, ArtworkCacheEntry>()

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

async function artworkForTrack(
  key: string,
  legacyKey: string,
  target: {
    title: string
    artist: string
    album: string
    duration_ms: number
  },
  native: (() => Promise<string | null>) | null,
): Promise<{ artwork: Artwork | null; duration_ms: number; loading: boolean }> {
  let entry = artworkCache.get(key)
  if (!entry) {
    entry = {
      value: null,
      duration_ms: target.duration_ms,
      pending: false,
      attempts: 0,
      retry_at: 0,
    }
    artworkCache.set(key, entry)
    if (artworkCache.size > 32) {
      const oldest = artworkCache.keys().next().value
      if (oldest) artworkCache.delete(oldest)
    }
  }

  if (
    !entry.value &&
    !entry.pending &&
    entry.attempts < 3 &&
    Date.now() >= entry.retry_at
  ) {
    entry.pending = true
    entry.attempts++
    const activeEntry = entry
    void (async () => {
      const data = await native?.()
      return resolveArtworkDetails(key, target, data ?? null, legacyKey)
    })().then(
      (resolution) => {
        activeEntry.value = resolution.artwork
        activeEntry.duration_ms = resolution.duration_ms
        activeEntry.pending = false
        if (!resolution.artwork) {
          activeEntry.retry_at =
            Date.now() + 2_000 * 2 ** (activeEntry.attempts - 1)
        }
      },
      () => {
        activeEntry.pending = false
        activeEntry.retry_at =
          Date.now() + 2_000 * 2 ** (activeEntry.attempts - 1)
      },
    )
  }
  return {
    artwork: entry.value,
    duration_ms: entry.duration_ms,
    loading: entry.pending,
  }
}

export function createSystemMedia(
  overrides: Partial<SystemMediaDependencies> = {},
): MusicBackend {
  const core = createSystemMediaCore(overrides)
  const runCmd = overrides.run ?? defaultRun

  return {
    ...core,
    async player(): Promise<PlayerState | null> {
      const state = await core.player()
      if (!state?.track) {
        return state as PlayerState | null
      }

      const track = state.track
      const identity = identityFromTrack(track)
      const artworkKey = artworkCacheKey(identity)

      const artworkState = await artworkForTrack(
        artworkKey,
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
      )

      return {
        ...state,
        track: {
          ...track,
          duration_ms:
            track.duration_ms > 0
              ? track.duration_ms
              : artworkState.duration_ms,
          artwork: artworkState.artwork,
          artwork_loading: artworkState.loading,
        },
      }
    },

    async searchTracks(): Promise<never> {
      throw {
        status: 501,
        message: "Search in the app that's playing",
      } satisfies MusicError
    },
  }
}

export function openNowPlayingApp() {
  Bun.spawn(["open", "https://music.youtube.com"], {
    stdout: "ignore",
    stderr: "ignore",
  })
}
