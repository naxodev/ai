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
  type SystemMediaDependencies,
  run,
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
