# `@naxodev/music-core`

Host-neutral music-session contracts, a same-user machine-local client boundary, and compatibility APIs for Pi and OpenCode.

## Requirements

- Node.js or Bun within the [declared runtime ranges](../../docs/package-compatibility.md); the reference distinguishes these lower bounds from tested runtime evidence
- macOS for system media discovery and transport
- A TypeScript-aware runtime or bundler because the package publishes TypeScript source

## Install

![Music-core architecture linking OpenCode and Pi to one daemon, with playback visualization output](https://raw.githubusercontent.com/naxodev/ai/main/docs/media/music-core/preview.png)

[Watch the silent library demo (18 seconds)](https://cap.so/s/sejery4s2bkx78a). The example runs `createEngine`, `stepEngine`, and `displayLevel` with synthetic playback samples. The diagram describes the architecture; the visualization does not analyze audio.

```sh
bun add @naxodev/music-core
```

The formatting, clock, reconciliation, waveform, and protocol APIs are platform-neutral. `createSystemMedia()` and the managed music-session daemon require macOS media providers.

## Session architecture

Many host clients connect to one owner-only Unix socket daemon. The daemon selects and owns one provider, its event source, playback clock, recovery polling, state and status authority, global transport queue, and native artwork reads. Clients receive hello, status, and state replay on connection, followed by revisioned updates. Host presentation remains outside this package.

The implementation uses Effect v4 ownership rather than host timers and provider processes: `Config` validates runtime limits and timing, `Schema` validates untrusted protocol and provider data, and Layers/scopes own the provider, coordinator, listener, connections, and finalizers. `Schedule` paces startup and reconnect, `SubscriptionRef` provides replayable status and state, and bounded queues, semaphores, and streams isolate command, sampling, fan-out, and artwork work.

Read the [music session architecture field guide](../../docs/music-session-architecture.html) for the complete ownership and failure model.

## Public surface

### Playback toggle contract

Pi and OpenCode send one `toggle()` command for each play/pause activation. The daemon resolves each toggle against its latest accepted playback state when the command leaves the global queue. It sends `pause` if playback is active and `play` otherwise. It does not resample the provider before each command.

A stale view therefore cannot choose the action. If Pi starts playback while OpenCode still shows paused, the next OpenCode activation pauses playback. The displayed icon describes the last received state; it does not bind the command to that displayed action.

Rapid activations remain separate queued commands. Two successful toggles with no intervening state change return playback to its starting state. Actions from other clients share the queue in daemon admission order. Provider events can also update the accepted state between commands.

Command acknowledgements settle loading and error feedback. Hosts update playback presentation from revisioned state snapshots, not from acknowledgements or local click counts. A failed toggle does not project a successful state change. Disconnected commands fail rather than replaying after reconnect. Explicit `play()` and `pause()` remain available for callers that need a specific action.

### Host-side catalog artwork

`acquireCatalogArtwork(target, options)` runs in the host process. It returns bounded image bytes and matched duration, or an `unavailable`, `exhausted`, or `aborted` outcome. It does not modify daemon playback state, decode images, or cache presentation.

Matching requires normalized exact title, exact album when supplied, and duration within 1,000ms when known. Exact artist text takes priority. If no compatible exact artist match exists, comma-separated and spaced-ampersand credits may match in a different order. This fallback requires every complete credit to match and exactly one compatible result, even when duration is known. It does not use partial artist names or split slashes in band names. A target without duration must have exactly one metadata match. Catalog durations must be positive, finite, and at most 24 hours. Search payloads must contain at most ten well-typed results.

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
  audioVisualizationCapability,
  audioFeatureFreshness,
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

## Optional audio visualization

Audio capture is a separate daemon authority from playback. It is off unless a client opts in, and the production adapter does not open a tap.

Pass `audioVisualizationCapability` in addition to `baselineCapabilities`. Do not add it to `baselineCapabilities`: current hosts would silently opt in. Negotiation requires protocol major 1 revision 2. Revision 0 and 1 clients stay on playback, artwork, and state only. A new client can keep using an older daemon; audio reports unavailable and the client does not replace that daemon.

`listAudioSources`, `startAudioCapture`, and `stopAudioCapture` are the control methods. `subscribeAudioStatus` and `subscribeAudioFeatures` observe capture. Listing or subscribing does not start it. Start requires a daemon-issued token for the current connection. Reconnect does not replay Start. Metadata-only clients do not keep capture alive.

Bun and Node have distinct monotonic origins. Hello supplies an audio clock snapshot only for revision 2 clients that opt in. The client maps its local monotonic time into the daemon domain and adds handshake uncertainty so old bytes expire early. `publishedAtMs` and `timestampMs` use that daemon domain, labeled `clockDomain: "capture-monotonic"`. `sampleAgeMs` carries sample age at publication. Acquisition age and time since publication both count against freshness; local receipt does not freshen queued samples. The local helper's clock conversion has [synthetic verification](../../docs/music-audio-visualization-plan.md#2-signed-helper-and-native-ownership), not a general device or distribution guarantee.

Each frame includes `daemonInstanceId`, `generation`, `sequence`, canonical `source`, and `capabilities`. `spectrum` is always an array: absent spectrum requires `[]`, while measured silence contains zero-valued bands. Absent `envelope` and `channels` keys are omitted. A measured envelope contains paired `{ min, max }` buckets. Measured channels contain `{ layout, rms, peaks }`, with one value per array for mono and two for stereo. Bounds are provisional: 20 Hz, 64 spectrum bands, 128 envelope buckets, and 16 KiB per frame.

Feature callbacks receive frames or `{ type: "clear", reason, generation, sequence }`. Clear reasons include `stale`, `stopped`, `source-loss`, `disconnected`, `failed`, `unavailable`, and `inactive`. Clears cancel feature expiry immediately. Expiry preserves sequence and timestamp watermarks. Features-only listeners also subscribe to authoritative audio status; Stop and source loss do not disconnect playback.

Deterministic tests cover shared shutdown completion and failure, a 10,000-frame latest-value burst at 50 ms cadence, and Stop/restart cancellation. Socket fixtures verify negotiated audio alongside usable playback. Separate synthetic checks exercise the Swift helper and isolated sidebar. The [live evidence record](../../docs/music-local-daemon-audio-evidence.md) identifies the exact historical Kaset implementation and its limits. Production capture remains unavailable; these results do not clear signing, permission, attribution, or sustained-performance release gates.

### Local-only native helper adapter

`makeNativeHelperAdapter(dependencies?)` returns an Effect that builds an `AudioCaptureAdapter`. Its trusted `artifactPresent`, `verify`, and synchronous `spawn` seams support offline tests. Importing the factory does not launch anything or run a command. Without the explicit local flag and separate socket, the daemon uses `unavailableLayer`; production capture remains unavailable. See the [local-only guide](../../docs/music-local-daemon-audio.md) for that separate build and test path.

Resolution uses only `audio/native/music-audio-helper` inside this package. No helper ships yet. Before every spawn, the live verifier runs `/usr/bin/codesign --verify --strict` with an explicit identifier requirement for `dev.naxo.music.audio-helper`. A missing, unsigned, modified, or differently identified helper cannot start capture. Availability stays a cheap artifact check, so one failed verification cannot make a corrected helper unreachable without a daemon restart. This identifier and artifact layout are local contract candidates, not a verified distribution design.

Protocol 1 passes `--process-id`, `--launch-identity`, `--executable-identity`, and `--core-audio-object` as separate arguments with `shell: false`. Stdout contains newline-delimited `AudioFeatureDraft` objects. Readiness requires the first valid draft. Lines are limited to 16 KiB; schema bounds limit bands, envelope buckets, and channels. Malformed frames fail the session. The adapter retains one replaceable pending draft. Stderr never supplies control messages; it is drained with a saturating byte counter and no retained text or logs.

The parent writes a heartbeat plus a newline to stdin immediately, then every two seconds. Each heartbeat includes `type: "heartbeat"`, `clockDomain: "capture-monotonic"`, and the parent's current monotonic `timestampMs`. The helper rejects packets missing the clock fields. It maps its native sample clock against those timestamps; delayed delivery counts against freshness.

A separate five-second monotonic deadline covers readiness and output stalls. Only a valid frame renews that deadline. Normal shutdown stops I/O, sends SIGTERM, and awaits exit. A one-second grace precedes SIGKILL, followed by a one-second exit deadline. Hard kill reports abnormal cleanup, even after exit. Concurrent shutdown callers join one cached result. Scope closure also joins cleanup, including blocked startup.

The local Swift helper, independent watchdog, and clock conversion are implemented and tested with synthetic input. Ad-hoc signing permits local integrity checks; it is not signed distribution. Mapped-file ownership uses public `PROC_PIDREGIONPATHINFO` and fails closed when that walk cannot prove a single Kaset cache owner. Notarization, shipped-helper permission attribution, and a live check of this public walk remain release gates. Verification and spawn retain a same-user file-replacement race; distribution must settle artifact ownership before release. Synthetic checks do not prove live resource teardown, and the historical live test does not verify this head.

## Lifecycle and compatibility

Concurrent callers that find no endpoint converge through owner-only startup-marker coordination; socket binding remains the final singleton authority. Hello negotiates a supported revision and capability intersection, so supported legacy and current package versions can share a live daemon. An incompatible client receives terminal range details and cannot unlink, replace, or otherwise disturb the healthy generation.

A reconnecting client retains its last accepted state for presentation. It adopts a replacement only after hello and replay succeed, fences old daemon instance IDs and revisions, and never replays commands. Commands unresolved at connection loss are indeterminate. When the last negotiated client leaves, the daemon starts a bounded idle grace; final cleanup removes only artifacts whose ownership it has proven.

## Bounds and cost

Frames, queues, and pending requests are finite. A slow or abusive connection can be disconnected locally without blocking other clients; state fan-out coalesces while required responses and status remain preserved. Provider observation is O(1), client fan-out is O(N), and the native-artwork path is bounded and deduplicated. The verified 24-client alternating scenario is capacity evidence, not a configured maximum.

Native artwork defaults to 512 KiB of decoded image bytes, also its schema ceiling. Session frames default to 768 KiB to fit base64 and the response envelope. Smaller configured frames reduce the effective artwork budget. Playback snapshots and provider metadata-stream lines remain bounded at 64 KiB.

The `native-artwork-512k` capability enables larger artwork responses. Clients with a frame limit below 768 KiB omit this capability. Clients below 64 KiB also omit `native-artwork`: artwork requests return `UNSUPPORTED_CAPABILITY` without sending a request, so oversized artwork cannot disconnect playback. Other older peers receive `too-large` for artwork that exceeds their 64 KiB frame budget and remain connected. Both client and daemon must be updated to use the larger budget; a running older daemon retains its original limits.

See the [artwork limit research](../../docs/music-artwork-limits-research.md) for the historical evidence, base64 arithmetic, and memory tradeoffs.

## Low-level provider compatibility

`createSystemMedia()` exposes normalized media discovery and transport for low-level consumers. It supports provider event subscriptions when available and polling-only fallback behavior, but it does not describe the production host topology. Use the session client for shared daemon ownership.

## Community

Use [GitHub Discussions](https://github.com/naxodev/ai/discussions) for usage questions and [GitHub Issues](https://github.com/naxodev/ai/issues) for reproducible defects. Report vulnerabilities through the workspace [security policy](../../SECURITY.md).

## License

[MIT](LICENSE)
