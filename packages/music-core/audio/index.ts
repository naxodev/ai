/**
 * Offline audio-visualization contracts and capture ownership.
 *
 * Production capture is unavailable. Importing this module does not open a
 * Core Audio tap, launch a helper, or record audio. Hosts opt in with
 * `audioVisualizationCapability`; it is not part of `baselineCapabilities`.
 */
export {
  AUDIO_CLOCK_DOMAIN,
  AUDIO_PENDING_TASK_LIMIT,
  AUDIO_PROTOCOL_REVISION,
  AUDIO_SAMPLE_AGE_EXPIRY_MS,
  AUDIO_SELECTION_TOKEN_TTL_MS,
  AudioCaptureStatus,
  AudioFeatureCapabilities,
  AudioFeatureDraft,
  AudioFeatureFrame,
  AudioSourceList,
  AudioStartResult,
  AudioStopResult,
  AudioRenewResult,
  CaptureIdentity,
  CooperativeCaptureIdentity,
  MAX_AUDIO_FEATURE_FRAME_BYTES,
  MAX_AUDIO_FEATURE_HZ,
  MAX_AUDIO_SOURCES,
  MAX_ENVELOPE_BUCKETS,
  MAX_SPECTRUM_BANDS,
  NativeCaptureIdentity,
  ResolvedCaptureSource,
  audioFeatureFreshness,
  audioVisualizationCapabilities,
  audioVisualizationCapability,
  audioInterestLeaseCapability,
  AUDIO_INTEREST_LEASE_MS,
  AUDIO_INTEREST_RENEW_MS,
  AUDIO_STARTUP_INTEREST_MS,
  isPidReuse,
  sameCaptureIdentity,
  unavailableAudioSourceList,
} from "./schema.ts"
export type {
  AudioCaptureStatus as AudioCaptureStatusValue,
  AudioFeatureCapabilities as AudioFeatureCapabilitiesValue,
  AudioFeatureDraft as AudioFeatureDraftValue,
  AudioFeatureFrame as AudioFeatureFrameValue,
  AudioSourceList as AudioSourceListValue,
  AudioStartResult as AudioStartResultValue,
  AudioStopResult as AudioStopResultValue,
  AudioRenewResult as AudioRenewResultValue,
  CaptureIdentity as CaptureIdentityValue,
  ResolvedCaptureSource as ResolvedCaptureSourceValue,
} from "./schema.ts"
export { localMonotonicMs, mapAudioClock } from "./clock.ts"
export type { AudioClockMapping } from "./clock.ts"
export {
  makeProviderSourceObservationBus,
  readProviderSourceHint,
  unavailableAudioSourceResolver,
  unavailableProviderSourceObservation,
  unavailableSourceObservations,
} from "./source.ts"
export type {
  AudioSourceResolver,
  ProviderSourceHint,
  ProviderSourceObservation,
  ProviderSourceObservationBus,
} from "./source.ts"
export {
  AudioAdapterError,
  AudioCapture,
  layerFromAdapters,
  makeAudioCapture,
  unavailableAudioCaptureAdapter,
  unavailableLayer,
} from "./capture.ts"
export { makeNativeHelperAdapter } from "./native-helper.ts"
export type {
  NativeHelperDependencies,
  NativeHelperExit,
  NativeHelperProcess,
  NativeHelperSpawnRequest,
} from "./native-helper.ts"
export type {
  AudioCaptureAdapter,
  AudioCaptureHandle,
  AudioCaptureOptions,
} from "./capture.ts"
