import type {
  MusicBackend as CoreMusicBackend,
  PlayerState as CorePlayerState,
  Track as CoreTrack,
} from "@naxodev/music-core"
import {
  emptyPlayer as emptyCorePlayer,
  formatMs,
  isMac,
} from "@naxodev/music-core"

export type { Device, MusicError } from "@naxodev/music-core"
export { formatMs, isMac }

export type Artwork = {
  id: string
  png_base64: string
  accent: string
  cells: Array<Array<{ upper: string; lower: string }>>
}

export type Track = CoreTrack & { artwork: Artwork | null }

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
