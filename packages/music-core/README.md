# `@naxodev/music-core`

Host-neutral contracts and logic shared by the Pi and OpenCode music plugins.

## Purpose

Shared Now Playing behavior so both hosts consume one implementation:

- player/track types and helpers
- `formatMs` progress formatting
- playback clock (`syncFromSample`, `liveFromClock`, `trackKey`, `resetClock`, `setClockPlaying`, `seekClock`)
- track reconciliation (`mergePlayer`)
- waveform engine primitives (`createEngine`, `stepEngine`, `isFlat`)
- portable CLI runner (`run`) and system-media provider (`createSystemMedia`, bundle labels, backend detection)
- optional provider-change subscriptions (`MusicBackend.subscribe`)

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
  emptyPlayer,
  isMac,
  // format
  formatMs,
  // clock
  type Clock,
  liveFromClock,
  trackKey,
  syncFromSample,
  resetClock,
  setClockPlaying,
  seekClock,
  // reconcile
  mergePlayer,
  // waveform engine
  type WaveEngine,
  createEngine,
  stepEngine,
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

## Status

Pi and OpenCode consume this package for provider discovery and commands, normalized state, playback clocks, reconciliation, formatting, and waveform engine behavior.

## Provider changes

`media-control` backends provide `subscribe` for prompt invalidation when Now Playing may have changed. A listener does not receive provider data. It calls `player()` to obtain normalized state through the usual clock-reconciliation path.

`nowplaying-cli` remains polling-only and omits `subscribe`. The disposer returned by `subscribe` owns the `media-control stream` process and any pending retry timer. Call it during host teardown.
