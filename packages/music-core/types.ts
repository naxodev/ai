export type Track = {
  uri: string
  id: string
  name: string
  artists: string
  album: string
  duration_ms: number
}

export type Device = {
  id: string
  name: string
  type: string
  is_active: boolean
  volume_percent: number | null
  supports_volume: boolean
}

export type PlayerState = {
  is_playing: boolean
  progress_ms: number
  shuffle: boolean
  repeat: "off" | "track" | "context"
  device: Device | null
  track: Track | null
  fetched_at: number
}

export type MusicError = {
  status: number
  message: string
}

/** Releases resources owned by a provider-change subscription. */
export type MusicChangeDisposer = () => void

/** Authoritative normalized playback state from a complete stream sample. */
export type MusicChangeSnapshotEvent = {
  type: "snapshot"
  state: PlayerState
}

/**
 * Signals that the active media-control stream generation ended.
 * Hosts should recover by sampling through `player()`.
 */
export type MusicChangeInvalidationEvent = {
  type: "invalidation"
  reason: "stream-terminated"
}

export type MusicChangeEvent =
  MusicChangeSnapshotEvent | MusicChangeInvalidationEvent

/**
 * Optional event argument is additive: existing `() => void` listeners remain
 * valid and may ignore the payload.
 */
export type MusicChangeListener = (event?: MusicChangeEvent) => void

export type MusicBackend = {
  readonly id: string
  readonly label: string
  readonly remoteControl: boolean
  authenticated: () => boolean
  player: () => Promise<PlayerState | null>
  subscribe?: (listener: MusicChangeListener) => MusicChangeDisposer
  searchTracks?: (query: string, limit?: number) => Promise<Track[]>
  play: (opts?: { uri?: string }) => Promise<void>
  pause?: () => Promise<void>
  next?: () => Promise<void>
  previous?: () => Promise<void>
  seek?: (positionMs: number) => Promise<void>
  setVolume?: (percent: number) => Promise<void>
  setShuffle?: (state: boolean) => Promise<void>
  setRepeat?: (state: PlayerState["repeat"]) => Promise<void>
}

export function emptyPlayer(): PlayerState {
  return {
    is_playing: false,
    progress_ms: 0,
    shuffle: false,
    repeat: "off",
    device: null,
    track: null,
    fetched_at: Date.now(),
  }
}

export function isMac(): boolean {
  return process.platform === "darwin"
}
