# `@naxodev/music-core`

Host-neutral contracts and logic shared by the Pi and OpenCode music plugins.

## Purpose

Shared Now Playing behavior so both hosts consume one implementation:

- player/track types and helpers
- `formatMs` progress formatting
- backend-owned playback clocks (`createPlaybackClock`, `liveFromClock`, `trackKey`)
- track reconciliation (`mergePlayer`)
- frame-driven playback visualization (`createEngine`, `stepEngine`, `displayLevel`, `isFlat`); it generates levels and does not analyse audio
- portable CLI runner (`run`) and system-media provider (`createSystemMedia`, bundle labels, backend detection)
- optional provider-change subscriptions (`MusicBackend.subscribe`) with authoritative snapshots and stream-termination invalidations

Pi and OpenCode keep presentation, registration, lifecycle, and notifications in their host packages. Pi keeps ANSI waveform rendering. OpenCode keeps Solid presentation, artwork, and Kitty graphics.

## Public surface

```ts
import {
  // types
  type Track,
  type Device,
  type PlayerState,
  type MusicError,
  type MusicBackend,
  type MusicChangeDisposer,
  type MusicChangeListener,
  type MusicChangeEvent,
  type MusicChangeSnapshotEvent,
  type MusicChangeInvalidationEvent,
  emptyPlayer,
  isMac,
  // format
  formatMs,
  // clock
  type Clock,
  type PlaybackClock,
  type SampleSyncInput,
  type SampleSyncResult,
  createPlaybackClock,
  liveFromClock,
  trackKey,
  // reconcile
  mergePlayer,
  // waveform engine
  type WaveEngine,
  type WaveFrame,
  createEngine,
  stepEngine,
  livePlaybackPosition,
  displayLevel,
  isFlat,
  // runner + system media
  type CommandResult,
  type LineStreamCallbacks,
  type LineStreamDisposer,
  type LineStreamStarter,
  type SystemMediaDependencies,
  run,
  startLineStream,
  createSystemMedia,
  bundleLabel,
  effectiveBundle,
  hasMediaControl,
  hasNowPlayingCli,
  resetMediaBackend,
} from "@naxodev/music-core"
```

## Playback clocks

Each `createSystemMedia()` backend owns one `PlaybackClock`. Sampling, idle transitions, and successful play, pause, seek, next, and previous commands mutate only that instance.

For tests or custom providers, create an explicit clock:

```ts
const clock = createPlaybackClock()
clock.syncFromSample({
  key: trackKey("Song", "Artist", "id"),
  reported_ms: 10_000,
  duration_ms: 180_000,
  playing: true,
  rate: 1,
  now: Date.now(),
})
clock.setPlaying(false)
clock.seek(20_000)
clock.reset()
```

`liveFromClock` and `trackKey` stay stateless helpers. There is no module-global playback clock.

## Provider changes

`media-control` backends provide `subscribe` for immediate playback updates. Complete stream payloads are already normalized into authoritative `PlayerState` snapshots. Stream termination emits one invalidation so a host can recover by calling `player()`.

```ts
const stop = backend.subscribe?.((event) => {
  if (!event) return
  if (event.type === "snapshot") {
    applyPlayer(event.state)
    return
  }
  if (event.type === "invalidation" && event.reason === "stream-terminated") {
    void refreshFromPlayer()
  }
})
```

Existing `() => void` listeners remain valid and may ignore the event argument.

`nowplaying-cli` remains polling-only and omits `subscribe`.

The disposer returned by `subscribe` owns the active `media-control stream` process and any pending restart timer. Call it during host teardown. Disposal is idempotent: it invalidates the active generation, clears the retry timer once, disposes the stream once, and suppresses every late line, terminal callback, snapshot, invalidation, and restart.

## Status

Pi and OpenCode consume this package for provider discovery and commands, normalized state, playback clocks, reconciliation, formatting, and waveform engine behavior.
