import type {
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
  png_base64: string
  accent: string
  cells: Array<Array<{ upper: string; lower: string }>>
}

export type Track = CoreTrack & {
  artwork: Artwork | null
  artwork_loading?: boolean
}

export type PlayerState = Omit<CorePlayerState, "track"> & {
  track: Track | null
}

export type MusicBackend = Omit<CoreMusicBackend, "player" | "searchTracks"> & {
  player: () => Promise<PlayerState | null>
  searchTracks: (query: string, limit?: number) => Promise<Track[]>
}

export function emptyPlayer(): PlayerState {
  return {
    ...emptyCorePlayer(),
    track: null,
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
