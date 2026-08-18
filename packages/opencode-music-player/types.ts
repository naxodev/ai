import type {
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

export type SessionMediaSnapshotEvent = {
  type: "snapshot"
  state: PlayerState
}

/** Host-local projection of session provider/connection lifecycle. */
export type SessionMediaLifecycleEvent = {
  type: "lifecycle"
  message: string | null
  source: "connection" | "provider" | "acquisition"
}

export type SessionMediaEvent =
  SessionMediaSnapshotEvent | SessionMediaLifecycleEvent
export type SessionMediaListener = (event: SessionMediaEvent) => void
export type SessionMediaDisposer = () => void

/** The OpenCode controller's session-only media contract. */
export type SessionMedia = {
  player: () => Promise<PlayerState | null>
  play: () => Promise<unknown>
  pause: () => Promise<unknown>
  next: () => Promise<unknown>
  previous: () => Promise<unknown>
  seek: (positionMs: number) => Promise<unknown>
  subscribe: (listener: SessionMediaListener) => SessionMediaDisposer
  subscribePresentation: (
    listener: ArtworkPresentationListener,
  ) => SessionMediaDisposer
  dispose: () => Promise<void>
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
