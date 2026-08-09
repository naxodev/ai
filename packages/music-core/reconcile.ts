import type { PlayerState } from "./types.ts"

/** Keep progress monotonic; never let a poll un-pause a held pause. */
export function mergePlayer<T extends PlayerState>(
  prev: T | null,
  next: T | null,
): T | null {
  if (!next) return next
  if (!prev?.track || !next.track) return next
  if (prev.track.id !== next.track.id && prev.track.name !== next.track.name) {
    return next
  }

  const now = Date.now()
  const prevLive = prev.is_playing
    ? prev.progress_ms + (now - prev.fetched_at)
    : prev.progress_ms

  // Same track: ignore a sudden drop to ~0 while still playing.
  if (
    next.is_playing &&
    prevLive > 2000 &&
    next.progress_ms < 500 &&
    next.track.duration_ms > 0 &&
    next.progress_ms + 3000 < prevLive
  ) {
    return {
      ...next,
      progress_ms: Math.min(next.track.duration_ms, Math.round(prevLive)),
      fetched_at: now,
    }
  }
  return next
}
