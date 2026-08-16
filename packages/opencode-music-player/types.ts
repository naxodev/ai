import type {
  MusicChangeDisposer,
  MusicChangeEvent as CoreMusicChangeEvent,
  MusicBackend as CoreMusicBackend,
  PlayerState as CorePlayerState,
  Track as CoreTrack,
} from "@naxodev/music-core"
import {
  emptyPlayer as emptyCorePlayer,
  formatMs,
  isMac,
  mergePlayer,
  sameTrackIdentity,
} from "@naxodev/music-core"

export type { Device, MusicError } from "@naxodev/music-core"
export { formatMs, isMac }

export type Artwork = {
  id: string
  legacy_id?: string
  png_base64: string
  accent: string
  cells: Array<Array<{ upper: string; lower: string }>>
}

/** Native IDs validate artwork samples; recording metadata keys artwork work. */
export type ArtworkIdentity = {
  uid: string
  title: string
  artist: string
  album: string
  duration_ms: number
}

export type ArtworkCompletionEvent = {
  type: "artwork-completion"
  identity: ArtworkIdentity
  artwork: Artwork | null
  duration_ms: number
}

export type ArtworkPresentationListener = (
  event: ArtworkCompletionEvent,
) => void

export type Track = CoreTrack & {
  artwork: Artwork | null
  artwork_loading?: boolean
}

export type PlayerState = Omit<CorePlayerState, "track"> & {
  track: Track | null
}

export type MusicChangeEvent =
  | (Omit<Extract<CoreMusicChangeEvent, { type: "snapshot" }>, "state"> & {
      state: PlayerState
    })
  | Exclude<CoreMusicChangeEvent, { type: "snapshot" }>
  /** Host-local projection of session provider/connection lifecycle. */
  | {
      type: "lifecycle"
      message: string | null
      /** Distinguishes terminal/reconnect authority from provider feedback. */
      source?: "connection" | "provider" | "acquisition"
    }

export type MusicChangeListener = (event?: MusicChangeEvent) => void

export type MusicBackend = Omit<
  CoreMusicBackend,
  "player" | "searchTracks" | "subscribe"
> & {
  player: () => Promise<PlayerState | null>
  searchTracks: (query: string, limit?: number) => Promise<Track[]>
  subscribe?: (listener: MusicChangeListener) => MusicChangeDisposer
  subscribePresentation?: (
    listener: ArtworkPresentationListener,
  ) => MusicChangeDisposer
  /** Optional asynchronous host-resource release. */
  dispose?: () => void | Promise<void>
}

export function emptyPlayer(): PlayerState {
  return {
    ...emptyCorePlayer(),
    track: null,
  }
}

/** Merge an independent artwork result without accepting stale playback data. */
export function mergeArtworkCompletion(
  player: PlayerState | null,
  event: ArtworkCompletionEvent,
): PlayerState | null {
  const track = player?.track
  if (
    !track ||
    track.name !== event.identity.title ||
    track.artists !== event.identity.artist ||
    track.album !== event.identity.album ||
    (track.duration_ms > 0 && track.duration_ms !== event.identity.duration_ms)
  ) {
    return player
  }
  return {
    ...player,
    track: {
      ...track,
      artwork: event.artwork,
      artwork_loading: false,
      duration_ms:
        track.duration_ms > 0 ? track.duration_ms : event.duration_ms,
    },
  }
}

/** Keep same-track presentation stable across incomplete provider samples. */
export function mergePlayerPresentation(
  previous: PlayerState | null,
  next: PlayerState | null,
): PlayerState | null {
  const merged = mergePlayer(previous, next)
  const matchingMetadata =
    !!previous?.track?.name &&
    !!merged?.track?.name &&
    !!previous.track.artists &&
    !!merged.track.artists &&
    previous.track.name === merged.track.name &&
    previous.track.artists === merged.track.artists
  const compatibleAlbum =
    !previous?.track?.album ||
    !merged?.track?.album ||
    previous.track.album === merged.track.album
  const compatibleDuration =
    !previous?.track?.duration_ms ||
    !merged?.track?.duration_ms ||
    Math.abs(previous.track.duration_ms - merged.track.duration_ms) <= 1_000
  if (
    !previous?.track ||
    !merged?.track ||
    (!sameTrackIdentity(previous.track, merged.track) && !matchingMetadata) ||
    !compatibleAlbum ||
    !compatibleDuration
  ) {
    return merged
  }

  return {
    ...merged,
    track: {
      ...merged.track,
      duration_ms:
        merged.track.duration_ms > 0
          ? merged.track.duration_ms
          : previous.track.duration_ms,
      artwork: merged.track.artwork ?? previous.track.artwork,
    },
  }
}
