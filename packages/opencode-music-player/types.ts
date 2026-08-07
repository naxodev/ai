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

export type MusicBackend = {
  readonly id: string
  readonly label: string
  readonly remoteControl: boolean
  authenticated: () => boolean
  player: () => Promise<PlayerState | null>
  searchTracks: (query: string, limit?: number) => Promise<Track[]>
  play: (opts?: { uri?: string }) => Promise<void>
  pause?: () => Promise<void>
  next?: () => Promise<void>
  previous?: () => Promise<void>
  seek?: (positionMs: number) => Promise<void>
  setVolume?: (percent: number) => Promise<void>
  setShuffle?: (state: boolean) => Promise<void>
  setRepeat?: (state: PlayerState["repeat"]) => Promise<void>
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, "0")}`
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
