# `@naxodev/music-core`

Host-neutral music-session contracts, a same-user machine-local client boundary, and compatibility APIs for Pi and OpenCode.

## Requirements

- Node.js 22.19 or later, or Bun 1.3 or later
- macOS for system media discovery and transport
- A TypeScript-aware runtime or bundler because the package publishes TypeScript source

## Install

```sh
bun add @naxodev/music-core
```

The formatting, clock, reconciliation, waveform, and protocol APIs are platform-neutral. `createSystemMedia()` and the managed music-session daemon require macOS media providers.

## Session architecture

Many host clients connect to one owner-only Unix socket daemon. The daemon selects and owns one provider, its event source, playback clock, recovery polling, state and status authority, global transport queue, and native artwork reads. Clients receive hello, status, and state replay on connection, followed by revisioned updates. Host presentation remains outside this package.

The implementation uses Effect v4 ownership rather than host timers and provider processes: `Config` validates runtime limits and timing, `Schema` validates untrusted protocol and provider data, and Layers/scopes own the provider, coordinator, listener, connections, and finalizers. `Schedule` paces startup and reconnect, `SubscriptionRef` provides replayable status and state, and bounded queues, semaphores, and streams isolate command, sampling, fan-out, and artwork work.

Read the [music session architecture field guide](../../docs/music-session-architecture.html) for the complete ownership and failure model.

## Public surface

### Host-side catalog artwork

`acquireCatalogArtwork(target, options)` runs in the host process. It returns bounded image bytes and matched duration, or an `unavailable`, `exhausted`, or `aborted` outcome. It does not modify daemon playback state, decode images, or cache presentation.

Matching requires normalized exact title and artist, exact album when supplied, and duration within 1,000ms when known. A target without duration must have exactly one metadata match. Catalog durations must be positive, finite, and at most 24 hours. Search payloads must contain at most ten well-typed results.

Each acquisition makes at most three serial attempts, with 500ms and 1,000ms retry delays. Only network/read failures, request timeouts, HTTP 408/429, and HTTP 5xx responses retry. Mismatches, invalid data, oversized responses, and redirects stop immediately. The request deadline includes body reads: 4 seconds per search or image request, with a 26-second acquisition deadline. Each attempt buffers at most 512,000 search bytes and 3,000,000 image bytes: six requests and 10,536,000 accepted bytes across all attempts.

Image requests require HTTPS `.mzstatic.com` URLs without credentials or nondefault ports. Redirects are returned for rejection rather than followed. Rejected responses and interrupted readers are cancelled; reader locks and timers are released. Pass an `AbortSignal` to cancel replacement or disposed work. An injected fetcher must honor its request signal; late responses are still discarded and their bodies cancelled.

Retries and physical job release await response and reader cancellation, including asynchronous cleanup. A stalled cleanup retains its job slot beyond the cancellation deadline instead of allowing replacement work to exceed the concurrency bound. Cleanup rejection settles ownership without replacing the original acquisition outcome.

The `fetch` option supports controlled acquisition tests. `retryDelayMs` can reduce the base delay from 500ms, including zero; invalid or larger values cannot expand the budget. `format: "png"` requests a PNG catalog URL for Pi. Hosts still validate the actual format and decoded dimensions before rendering.

OpenCode retains its 32 active jobs, 32 deferred keys, and 32 settled cache entries per module instance. Equal recording work is shared between its views. The last interested view aborts obsolete work, but the job keeps its slot until its resolver settles. Pi owns one current artwork generation per live session. Both hosts suppress automatic retries after a settled outcome and expose `/music-artwork` to start a fresh bounded acquisition for the same track. Repeated refreshes during active work share that work.

### Other exports

```ts
import {
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
  formatMs,
  type Clock,
  type PlaybackClock,
  type SampleSyncInput,
  type SampleSyncResult,
  createPlaybackClock,
  liveFromClock,
  resetClock,
  seekClock,
  setClockPlaying,
  syncFromSample,
  trackKey,
  mergePlayer,
  sameTrackIdentity,
  type WaveEngine,
  type WaveFrame,
  createEngine,
  displayLevel,
  isFlat,
  livePlaybackPosition,
  stepEngine,
  waveformSeedKey,
  type CommandResult,
  type LineStreamCallbacks,
  type LineStreamDisposer,
  type LineStreamStarter,
  run,
  startLineStream,
  whichOk,
  type SystemMediaDependencies,
  createSystemMedia,
  bundleLabel,
  effectiveBundle,
  hasMediaControl,
  hasNowPlayingCli,
  resetMediaBackend,
  type MusicSessionClient,
  type MusicSessionClientOptions,
  type MusicSessionConnectionLifecycle,
  type ReconnectingMusicSessionClient,
  type ReconnectingMusicSessionClientOptions,
  createMusicSessionClient,
  createReconnectingMusicSessionClient,
  MusicSessionClientError,
  type ArtworkIdentity,
  type ArtworkResult,
  type Capability,
  type HostKind,
  type ProtocolError,
  type ProtocolErrorCode,
  type ProviderStatus,
  type RevisionedState,
  type TransportAction,
  PROTOCOL,
  baselineCapabilities,
} from "@naxodev/music-core"
```

The package also exports the track, device, player, formatting, clock, reconciliation, waveform, runner, and system-media compatibility symbols from `index.ts`. `createSystemMedia()` remains an intentional low-level provider API for compatibility and custom integrations. Production Pi and OpenCode hosts use the session client instead.

### Reconnecting client

```ts
import {
  baselineCapabilities,
  createReconnectingMusicSessionClient,
} from "@naxodev/music-core"

const client = await createReconnectingMusicSessionClient({
  clientId: "my-host-session",
  hostKind: "test",
  capabilities: [...baselineCapabilities],
})

const stopState = client.subscribeState((snapshot) => {
  render(snapshot.state)
})
const stopStatus = client.subscribeStatus((status) => {
  renderStatus(status)
})

await client.play()
stopState()
stopStatus()
await client.dispose()
```

Use a unique client ID and a valid host kind. Subscribe before rendering so replayed state and status can establish presentation, use the transport methods for commands, and await `dispose()` when the host lifecycle ends.

## Lifecycle and compatibility

Concurrent callers that find no endpoint converge through owner-only startup-marker coordination; socket binding remains the final singleton authority. Hello negotiates a supported revision and capability intersection, so supported legacy and current package versions can share a live daemon. An incompatible client receives terminal range details and cannot unlink, replace, or otherwise disturb the healthy generation.

A reconnecting client retains its last accepted state for presentation. It adopts a replacement only after hello and replay succeed, fences old daemon instance IDs and revisions, and never replays commands. Commands unresolved at connection loss are indeterminate. When the last negotiated client leaves, the daemon starts a bounded idle grace; final cleanup removes only artifacts whose ownership it has proven.

## Bounds and cost

Frames, queues, and pending requests are finite. A slow or abusive connection can be disconnected locally without blocking other clients; state fan-out coalesces while required responses and status remain preserved. Provider observation is O(1), client fan-out is O(N), and the native-artwork path is bounded and deduplicated. The verified 24-client alternating scenario is capacity evidence, not a configured maximum.

## Low-level provider compatibility

`createSystemMedia()` exposes normalized media discovery and transport for low-level consumers. It supports provider event subscriptions when available and polling-only fallback behavior, but it does not describe the production host topology. Use the session client for shared daemon ownership.

## Community

Use [GitHub Discussions](https://github.com/naxodev/ai/discussions) for usage questions and [GitHub Issues](https://github.com/naxodev/ai/issues) for reproducible defects. Report vulnerabilities through the workspace [security policy](../../SECURITY.md).

## License

[MIT](LICENSE)
