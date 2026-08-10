import type { PlayerState } from "./types.ts"

/**
 * Provider IDs are stable when metadata arrives late, but some providers reuse
 * them. Empty metadata is enrichment; conflicting complete metadata is a new
 * track.
 */
export function sameTrackIdentity(
  left: NonNullable<PlayerState["track"]>,
  right: NonNullable<PlayerState["track"]>,
): boolean {
  if (left.id && right.id && left.id !== right.id) return false
  if (left.name && right.name && left.name !== right.name) return false
  if (left.artists && right.artists && left.artists !== right.artists)
    return false
  return true
}

/** Keep progress monotonic; never let a poll un-pause a held pause. */
export function mergePlayer<T extends PlayerState>(
  prev: T | null,
  next: T | null,
): T | null {
  if (!next) return next
  if (!prev?.track || !next.track) return next
  if (!sameTrackIdentity(prev.track, next.track)) {
    return next
  }

  const preservesKnownMetadata =
    (!next.track.id && !!prev.track.id) ||
    (!next.track.name && !!prev.track.name) ||
    (!next.track.artists && !!prev.track.artists)
  const reconciled = preservesKnownMetadata
    ? ({
        ...next,
        track: {
          ...next.track,
          id: next.track.id || prev.track.id,
          name: next.track.name || prev.track.name,
          artists: next.track.artists || prev.track.artists,
        },
      } as T)
    : next
  const reconciledTrack = reconciled.track
  if (!reconciledTrack) return reconciled

  const now = Date.now()
  const prevLive = prev.is_playing
    ? prev.progress_ms + (now - prev.fetched_at)
    : prev.progress_ms

  // Same track: ignore a sudden drop to ~0 while still playing.
  if (
    reconciled.is_playing &&
    prevLive > 2000 &&
    reconciled.progress_ms < 500 &&
    reconciledTrack.duration_ms > 0 &&
    reconciled.progress_ms + 3000 < prevLive
  ) {
    return {
      ...reconciled,
      progress_ms: Math.min(reconciledTrack.duration_ms, Math.round(prevLive)),
      fetched_at: now,
    }
  }
  return reconciled
}
