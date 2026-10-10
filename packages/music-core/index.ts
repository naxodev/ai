export * from "./catalog-artwork.ts"

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
export {
  createPlaybackClock,
  liveFromClock,
  resetClock,
  seekClock,
  setClockPlaying,
  syncFromSample,
  trackKey,
} from "./clock.ts"

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
export type {
  ArtworkShrinker,
  SystemMediaDependencies,
} from "./system-media.ts"
export {
  createSystemMedia,
  bundleLabel,
  effectiveBundle,
  hasMediaControl,
  hasNowPlayingCli,
  resetMediaBackend,
} from "./system-media.ts"

// machine-local session client
export type {
  MusicSessionClient,
  MusicSessionClientOptions,
  MusicSessionConnectionLifecycle,
  ReconnectingMusicSessionClient,
  ReconnectingMusicSessionClientOptions,
} from "./session/client.ts"
export {
  createMusicSessionClient,
  createReconnectingMusicSessionClient,
  MusicSessionClientError,
} from "./session/client.ts"
export type {
  ArtworkIdentity,
  ArtworkResult,
  Capability,
  HostKind,
  ProtocolError,
  ProtocolErrorCode,
  ProviderStatus,
  RevisionedState,
  TransportAction,
} from "./session/protocol.ts"
export {
  AUDIO_PROTOCOL_REVISION,
  PROTOCOL,
  audioVisualizationCapabilities,
  audioVisualizationCapability,
  audioInterestLeaseCapability,
  baselineCapabilities,
} from "./session/protocol.ts"
export type {
  AudioCaptureStatus,
  AudioFeatureFrame,
  AudioSourceList,
  AudioStartResult,
  AudioStopResult,
  AudioRenewResult,
  CaptureIdentity,
} from "./audio/schema.ts"
// Local-only helper contract. The daemon's production capture stays unavailable.
export { makeNativeHelperAdapter } from "./audio/native-helper.ts"
export type {
  NativeHelperDependencies,
  NativeHelperExit,
  NativeHelperProcess,
  NativeHelperSpawnRequest,
} from "./audio/native-helper.ts"
export {
  AUDIO_SAMPLE_AGE_EXPIRY_MS,
  MAX_AUDIO_FEATURE_FRAME_BYTES,
  MAX_AUDIO_FEATURE_HZ,
  MAX_ENVELOPE_BUCKETS,
  MAX_SPECTRUM_BANDS,
  audioFeatureFreshness,
} from "./audio/schema.ts"
