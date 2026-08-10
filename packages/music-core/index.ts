// types
export type {
  Track,
  Device,
  PlayerState,
  MusicError,
  MusicBackend,
  MusicChangeDisposer,
  MusicChangeListener,
  MusicChangeEvent,
  MusicChangeSnapshotEvent,
  MusicChangeInvalidationEvent,
} from "./types.ts"
export { emptyPlayer, isMac } from "./types.ts"

// format
export { formatMs } from "./format.ts"

// clock
export type {
  Clock,
  PlaybackClock,
  SampleSyncInput,
  SampleSyncResult,
} from "./clock.ts"
export { createPlaybackClock, liveFromClock, trackKey } from "./clock.ts"

// reconcile
export { mergePlayer, sameTrackIdentity } from "./reconcile.ts"

// waveform engine
export type { WaveEngine, WaveFrame } from "./waveform.ts"
export {
  createEngine,
  displayLevel,
  isFlat,
  livePlaybackPosition,
  stepEngine,
  waveformSeedKey,
} from "./waveform.ts"

// CLI runner
export type {
  CommandResult,
  LineStreamCallbacks,
  LineStreamDisposer,
  LineStreamStarter,
} from "./run.ts"
export { run, startLineStream, whichOk } from "./run.ts"

// system media
export type { SystemMediaDependencies } from "./system-media.ts"
export {
  createSystemMedia,
  bundleLabel,
  effectiveBundle,
  hasMediaControl,
  hasNowPlayingCli,
  resetMediaBackend,
} from "./system-media.ts"
