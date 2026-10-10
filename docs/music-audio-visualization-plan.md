# Production audio visualization integration plan

## Current direction

Nacho rejected the timestamp-synchronized profile approach because it requires a local audio file for each recording. The profile generator, cache loader, and waveform hooks have been removed. The current direction is live visualization without per-track setup.

Approved local Kaset capture and a controlled other-process isolation check passed on this Mac through the prototype. Nacho confirmed that its live sidebar works. The [local prototype guide](../packages/opencode-music-player/prototypes/audio-reactive/README.md#try-kaset-in-the-sidebar) records that path. A separate [shared-daemon live test](music-local-daemon-audio-evidence.md) now verifies sustained local Kaset spectrum and explicit Stop beyond 30 seconds. It does not repeat the prototype's isolation check. Capture stays off by default. Signed distribution and release require separate decisions.

Linux remains a requirement. Linux player discovery, controls, and capture remain unimplemented. The broader native-capture design below is retained as a proposal, not approval to implement every phase.

This plan moves real-audio visualization into the shared music daemon without merging the throwaway prototype. It defines ownership, privacy rules, and implementation gates for maintainers who know the existing session architecture. The interfaces below are proposals, not available package exports.

The first delivery targets OpenCode. Music-core owns the host-neutral capture module. Pi keeps its existing presentation until a separate integration is requested.

## Evidence and limits

The [prototype README](../packages/opencode-music-player/prototypes/audio-reactive/README.md) records automated checks and local capture experiments. The [capture research](music-audio-visualization-research.md) and [player comparison](cli-audio-visualization-comparison.md) explain backend choices and capability limits.

Nacho confirmed these additional local observations after the handoff:

- The sidebar worked and looked good.
- Headphone/output switching worked during the local test.
- After CLIAMP restarted, starting capture again worked.
- The animation stopped around that restart. The cause was not established: source exit and the 30-second deadline remain possible.

These observations establish manual recovery on this Mac. They do not establish automatic relaunch recovery, uninterrupted capture across restart, or general device compatibility.

Signing, permission denial/revocation/update behavior, helper-process attribution, additional players, and sustained performance remain release gates.

## Ownership and module placement

The existing music-session coordinator owns provider state and playback commands. Capture needs a separate scoped module in the same singleton daemon graph. Adding capture to the playback command worker would let permission prompts and helper shutdown delay Play or Next.

Proposed flow:

```text
Validated player identity or explicit process selection
  -> daemon-issued source selection
  -> user confirmation and daemon revalidation
  -> one capture adapter and native analysis worker
  -> bounded feature frames with capture generation
  -> daemon latest-frame fan-out
  -> independent OpenCode visualization renderer
```

Implementation locations:

- `packages/music-core/system-media.ts` and `session/provider.ts`: retain structured source identity alongside authoritative provider observations.
- New `packages/music-core/audio/` module: source resolution, capture ownership, adapter contracts, feature validation, and helper management.
- `session/music-sessiond.ts` and `session/server.ts`: wire one scoped capture owner into the daemon and its connections.
- `session/protocol.ts`, `session/client.ts`, and `index.ts`: expose negotiated controls, status, and feature subscriptions.
- `packages/opencode-music-player/system-media.ts` and `index.tsx`: adapt the client through ordinary values, callbacks, and Promises.
- New OpenCode visualization module plus `ui.tsx`: pure renderers and presentation lifecycle.

Preserve the pinned Effect version and the [host dependency contract](opencode-compatibility.md). Do not pass daemon Effect services or fibers into the host. The public synthetic waveform engine remains unchanged for existing consumers.

## Source selection and capture authority

One daemon has at most one active capture session, including any retiring helper. Starting another session must join completed shutdown first. Never fall back to the global mix, microphone, or unresolved helper processes.

The proposed control interface has five operations: list sources, start an approved source, stop capture, subscribe to status, and subscribe to features. Listener disposal releases only that connection's interest. Subscription alone never authorizes capture.

Source listing returns bounded metadata, capabilities, and an opaque, short-lived selection token. The daemon binds the token to the connection and exact observed process identity. Native identity includes the process start identity, executable identity, and Core Audio object, not just a PID or display name. Start revalidates that identity after confirmation, then the helper validates it again before creating a tap. Expired tokens and changed identities require a fresh selection.

The token prevents stale selection errors. It cannot prove a UI showed consent or protect against malicious software running as the same user. The local socket and installed plugins remain within the existing same-user trust model.

Initial selection modes:

- **Choose a process:** capture all output from that exact process, not one song or browser tab.
- **Use Now Playing:** resolve the directly attributable process on Start. Stop when its ownership changes or cannot be verified. Do not capture a replacement automatically.
- **Cooperative feed:** select a verified player export explicitly. Never switch silently to native capture when its data is insufficient.

Persisting an application preference must not persist permission to capture it. Unbundled players need a verified executable/process identity, not a guessed bundle ID. Shared WebKit/browser helpers stay unavailable unless attribution and isolation are proven. Missing metadata in the fallback provider must remain unresolved.

Multiple windows share the same session only after explicit Start/join for the current source generation. A conflicting Start returns busy; it does not replace another window's source. Source changes require Stop and fresh approval. Stop ends the shared capture and reports that fact to every participating window.

Capture ends when the last explicitly joined connection releases its interest, disconnects, or expires its lease. Metadata-only clients must not keep capture alive. Daemon/client reconnects never replay Start, and old session tokens never transfer to a new daemon instance.

The local daemon gives acquisition a separate 30-second interest deadline. Once acquisition succeeds, each joined connection has a five-second lease. The client renews once per second through `audio-renew`, bound to that connection and capture generation. Renewal requires an existing, unexpired active interest. It cannot grant capture or revive an expired generation. The daemon checks expiry every 250 milliseconds; Stop, renewal, and feature admission also reject expired authority before that sweep.

The optional `audio-interest-lease-v1` capability extends revision 2 without changing revisions 0 or 1. Updated clients offer it when callers explicitly opt into audio. They refuse capture on older audio daemons that lack it, while keeping metadata and playback usable. Older revision-2 audio clients can start on the updated daemon, but their interest expires without renewal. This intentionally limits the unreleased local audio path; it does not replace a shared daemon.

Lease expiry retires the SDK client's audio lifetime, not its metadata or playback methods. A new Start requires a fresh client connection. The sidebar releases its expired socket and opens another one only on fresh source selection. This prevents a delayed same-generation expiry event from revoking a new join. A stopped-generation replay on a connection that never joined it does not retire that fresh connection.

Joined-generation and expiry evidence survive renewal cancellation. The decoder records admission before its Promise handler runs and handles either packet order. A newer unjoined global status cannot hide expiry of this connection's joined lifetime. Lifetime retirement preserves newer presentation metadata and does not revoke a newer admitted lease. Retired connections reject buffered feature frames.

The capture status subscription keeps at most 16 queued lifecycle events. Overflow ends that subscription, and the server closes only its connection. Lease-expiry status uses the socket's bounded mandatory queue, not its replaceable presentation slot. Overflow of that queue also closes the affected connection. Slow subscribers cannot erase expiry evidence or block native cleanup and healthy peers. Ordinary socket presentation and feature frames remain latest-only.

The first production version requires explicit restart after source loss. Automatic application relaunch following is deferred until executable identity, renewed consent scope, and helper ownership have their own tests.

## Independent protocol and feature stream

Extend protocol major 1 with a new negotiated revision and an optional `audio-visualization-v1` capability. Keep revisions 0 and 1 usable. Advertise the capability only at the supporting revision. Older clients receive no audio events; newer clients connected to an older daemon report unavailable without replacing a daemon used by other windows.

Define schemas for source selection, Start/Stop results, capture status, and features before implementing the adapter. Keep unsupported features distinct from zero-valued features.

Each feature frame carries:

- Daemon instance ID, capture generation, sequence number, and a monotonic sample timestamp.
- The selected source identity and adapter capabilities.
- Spectrum magnitudes, an optional signed min/max envelope, and optional channel RMS/sample peaks.

Initial budgets are engineering targets, subject to measurement: 20 frames/second, at most 64 spectrum bands, 128 envelope buckets, and 16 KiB per encoded feature frame. Validate finite numbers, paired envelope ordering, array lengths, channel semantics, sequence order, and generation at each external seam. Mono input must not masquerade as measured stereo.

Frames never advance `PlayerState` revisions. Track changes within the same approved process do not restart capture. Source changes invalidate the frame immediately, even when the track metadata appears unchanged.

Use one replaceable latest-frame slot per subscriber. The existing socket writer already prioritizes required responses over coalesced state. Add features below both, with a bounded rate. Do not put features in the required-response queue. Bound or disconnect stalled writers so socket backpressure cannot accumulate an animation history or block other clients. Bytes already written cannot be reprioritized, so measure control latency under load.

Define the timestamp clock domain and offset mapping before implementing freshness checks. Include sample age; local receipt time alone must not make buffered old samples fresh. Use an initial 500 ms sample-age expiry target, plus receipt-time expiry when delivery stops. Stale, stopped, or wrong-generation frames clear the visualization. Silence remains measured zero energy, not an error or generated animation. Status distinguishes setup failure, source loss, timeout, unsupported features, and confirmed permission failure. No callbacks alone do not prove permission denial.

## Adapters and native helper lifecycle

Two actual adapters justify the capture seam:

- A process-scoped Core Audio tap helper supplies the fuller feature bundle.
- CLIAMP's reviewed export supplies spectrum only. Scope and stereo meters remain unavailable on that adapter.

Selecting a style never changes the adapter, launches a second helper, or widens capture scope. MPD/mpv integrations are later adapters, not first-delivery requirements.

Reimplement the production helper around the prototype's proven signal processing and privacy invariants. Do not import production code from `prototypes/` or copy its runner lifecycle unchanged.

The audio callback performs bounded in-memory work only. Analysis and output run outside the callback. Conflate pending output before writing it. Keep PCM private to a bounded native ring; do not send raw recordings through the daemon, write files, or upload audio.

The parent owns termination and waits for helper exit. The helper also owns an independent lease watchdog and exits on parent-channel closure. An initial target is lease renewal every two seconds with expiry within five seconds, including blocked startup or output. Production can run beyond the prototype's 30-second limit only while approved, connected interests renew that lease.

Normal shutdown stops I/O and destroys the aggregate and tap. Hard termination remains a bounded fallback and is reported as abnormal cleanup. It is not evidence of successful native resource teardown. Device recovery may recreate capture resources only for the same revalidated source; it must never change the default output, include hardware inputs, or expand the process set.

## Signed distribution gate

Ship a prebuilt, versioned helper with music-core. Users must not need Swift/Xcode or an install-time compiler. Runtime selection uses a fixed package-relative path, not a configurable executable or a remote download.

The preferred candidate is a stable helper bundle with an explicit purpose string and Developer ID identity. Validate that choice before committing to its layout. Apple requires the audio purpose string and prompts when recording begins from a tap-containing aggregate. Its [Core Audio sample](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps) documents macOS 14.2 as the setup floor.

Apple's [notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) requires valid Developer ID signing, hardened runtime, and secure timestamps for distributed executables. Signing alone does not establish stable permission attribution for a helper launched by Bun or Node.

The distribution spike must determine and verify:

- A signing identity and protected release process, without changing existing provider credentials.
- Bundle identity, launch method, prompt attribution, and permission persistence across package paths and updates.
- arm64/x86_64 artifact policy and executable modes after npm pack/install. Prefer a universal helper if verified; do not claim an untested architecture.
- Notarization and ticket handling for the actual shipped artifact, including quarantined download and offline launch behavior.
- Signature/integrity rejection for a modified helper, and useful unavailable status for missing or unsupported binaries.
- Deny, grant, revoke, and update behavior while playback remains usable.

Retain macOS 14.2 as the API floor candidate, not a tested distribution promise. Gate newer SDK features explicitly. Do not repair this Mac's broken developer-tool launcher as part of integration.

## Delivery phases and acceptance gates

### 1. Contracts and offline ownership

Define the schemas and capture module with injected adapters. Preserve source identity with observation ordering; never combine an old PID with a newer player sample. Wire the optional capability without enabling live capture.

Tests must fail if concurrent Starts create two helpers, a confirmation becomes stale, PID reuse is accepted, shutdown ownership is lost, or the final joined connection leaves capture running. Cover conflicting windows, explicit joins, Stop during startup, daemon reconnect, old clients, and metadata-only clients.

Deliverable: a tested daemon/client contract with no change to the live plugin installation.

Historical offline evidence before the PR review fixes; no live tap was used. These counts describe that checkpoint, not the current head:

- `bun run --cwd packages/music-core test` passed 360 tests. Ownership tests cover shared blocked shutdown, concurrent owner closure and Start, cleanup failure, EOF, typed stream failure, interrupted final detach, acquisition-leader departure, revalidation cancellation, token reuse, PID reuse, and expiry.
- The single generation-tagged pending slot passed a deterministic 10,000-frame burst test. One TestClock drives both injected monotonic timestamps and Effect sleeps. The test checks the 50 ms cadence, latest value, and Stop/restart cancellation. Mixing a live monotonic origin with TestClock reproduced the earlier timeout; it was a test-clock mismatch, not evidence of verified production streaming.
- Client/protocol tests cover canonical source and capabilities, duplicate/reordered sequence, regressing timestamps, freshness watermarks, immediate typed clears, and exact expiry cancellation. Features-only listeners retain usable metadata and playback after Stop or source loss. Blocked Stop requests have bounded admission and do not delay Play.
- Fresh workspace `typecheck` passed all seven projects. `bun run lint` passed for 241 files. Core `pack:check` verified 27 package files. Pi passed 79 tests. Configured OpenCode tests passed 159 tests with the required preload. Prettier passed on changed files.
- Production capture adapters and resolvers remain unavailable. No native helper, signing, live audio, host presentation integration, or full release gate was verified. Bun and Node monotonic origins remain distinct; revision 2 opt-in hello mapping is retained. Native-helper clock conversion remains a Phase 2 gate.

### 2. Signed helper and native ownership

Complete the distribution spike before enabling production native capture. Add the native adapter, feature validation, lease watchdog, bounded diagnostics, and scoped cleanup.

The [distribution spike](music-audio-helper-distribution.md) measured this Mac. Universal builds, post-`lipo` re-signing, and tamper rejection are verified. Signed distribution is blocked: the machine holds zero valid codesigning identities and no Developer ID Application certificate. Release therefore stays blocked while local-only work continues behind the unavailable adapter.

Offline evidence for the local-only helper process boundary, which is not the release gate:

- The adapter resolves one fixed package-relative helper, verifies it with `codesign --verify --strict` plus an identifier requirement before every spawn, and never spawns an unverified binary.
- Start reports success only after a valid first frame. Parent heartbeats run every two seconds. The helper expires its lease after five seconds without renewal and separately bounds stalled output.
- Stdout lines and stderr diagnostics are bounded. Termination is shared: blocked and cancelled callers join one completed result, and a hard kill is reported as abnormal cleanup rather than success.
- Availability is a live artifact check, so a helper installed after daemon start stays listable without restarting the daemon.
- Default production capture remains unavailable. Without the explicit local flag, the daemon still builds `unavailableLayer`. The local Swift candidate is ad-hoc signed and excluded from npm packages. Signed distribution remains blocked.

The leased native candidate now has synthetic subprocess evidence:

- The build uses the installed Xcode compiler and SDK directly, treats Swift warnings as errors, and verifies the staged signature before replacing the local artifact. It changes no developer tools or installed preview.
- Each heartbeat includes the parent's `capture-monotonic` timestamp. Mapping at native receipt counts delivery delay against freshness. Sample age also prevents repeated delivery from freshening a held sample.
- Native revalidation checks the selected Core Audio object, PID, launch time (`seconds:microseconds`), and executable path plus signing hash (`path|hex-code-hash`). Changed identities fail closed. The future resolver must issue this exact identity format.
- A renewed lease sustained more than 600 synthetic frames beyond 30 seconds. Silence stayed zero, asymmetric stereo levels remained measured, and held samples became stale.
- Real subprocess fixtures verified lease expiry, parent death, SIGTERM, blocked startup, and OS-pipe backpressure. No tap was created and no audio was captured or played.
- Normal capture shutdown checks I/O stop, callback removal, aggregate destruction, and tap destruction. Exit 70 reports cleanup failure. Exit 125 reports hard-watchdog termination. The parent rejects both, and all signal exits, as proof of completed cleanup.
- A real pipe regression verifies that old read listeners cannot steal later bursts and that explicit pipe closure joins the reader. Offline ownership tests cover shared shutdown and cleanup failure.

`bun run --cwd packages/music-core native:check` rebuilds the local candidate and runs only synthetic or metadata-only checks. It requires macOS, the installed Xcode toolchain, Bun, and Node. Success ends with `Native helper checks passed. Synthetic input only; no audio captured or played.` This is not live-capture, permission, or performance verification.

The local Kaset resolver and daemon graph are now wired behind `--local-kaset-audio`. The flag requires a separate explicit socket and rejects the installed socket and its macOS alias. The helper's metadata-only catalog requires one attributed WebKit candidate. It pins the launch time, executable signing hash, and Core Audio object. A pause prevents a new selection without revoking an already approved process. Missing or ambiguous attribution cannot select a replacement.

The native helper checks the selected process's mapped Kaset cache association before creating a tap, before starting I/O, and during capture. Scans inspect path metadata only and have fixed count/time limits. A changed or unreadable association fails closed. The scanner's first metadata-only preflight failed on zero-sized WebKit VM regions. Launch and signing checks passed. The mapped-file-only walk now resolves one Kaset helper through the real daemon. Its private `PROC_PIDREGIONPATHINFO2` selector adds a release blocker; compatibility outside this Mac remains unverified. Native regressions cover the original failure, incomplete reads after a matched cache, and zero-sized records. The separate live evidence record verifies one sustained Kaset run at revision `4299bb46`.

The installed prototype retains its 30-second preview limit. Further Kaset capture through the new ownership path needs separate explicit approval. A [local test guide](music-local-daemon-audio.md) separates build-only checks from live capture and configuration changes.

Use deterministic tones, silence, impulses, and asymmetric channels to test analysis. Re-run approved live isolation, source exit, output switching, and explicit player restart with the production ownership path. Verify parent crash and blocked helper output do not leave capture running. Do not change the user's player or audio route unattended.

Deliverable: a packaged helper with verified permission attribution and source-scoped lifecycle. If signing or permission identity cannot be verified, remain local and do not release.

### 3. OpenCode presentation

Replace the real-audio view's synthetic input with the negotiated feature subscription. Add spectrum, mirror, scope, and stereo RMS/sample-peak meters. Use dBFS labels, not calibrated VU/LUFS claims.

Persist style in host storage. Do not persist active capture or replay Start on reload. Allocate six/four/one rows according to available sidebar space. Keep both channels in compact meters and label the compact scope as an amplitude envelope.

Tests must detect helper restarts on style changes, synthetic fallback for unavailable data, hidden-view capture retention, stale redraws, and overflow at narrow sizes. Packed-host fixtures cover selection, confirmation, Start/Stop, four styles, reload, and two-window ownership without using personal audio.

Deliverable: one integrated opt-in sidebar, capture off by default. Any retained decorative mode has an explicit animation label and never substitutes for real audio.

Local-only implementation evidence:

- `audio-visualization.ts` exposes a Promise/callback host boundary. It uses the negotiated client stream without passing Effect services into the UI. It never spawns a capture helper or starts a daemon.
- `audio-sidebar.tsx` renders spectrum, mirror, the min/max-envelope scope, and stereo RMS/sample-peak meters. Missing or stale features clear the view. Compact scope is labeled as an envelope; compact meters retain both channels.
- The optional local entry binds a separate socket at build time. It uses `/live-audio-source`, `/live-audio-start`, `/live-audio-style`, and `/live-audio-stop`, so it does not change the installed preview commands.
- Start requires source selection and confirmation. Stop fences pending confirmation and late admission. Concurrent Starts share one action. A failed request drops that connection's interest rather than retaining uncertain capture authority.
- Hiding or disposing the mounted sidebar releases its connection. Reconnect and reload do not replay Start. Only style is stored durably; source selection and capture approval are not stored.
- Disposal joins pending source, confirmation, and command work. Source selection is registered before execution, so a synchronous state subscriber cannot dispose before ownership exists. The host dialog API cannot close a specific owned dialog. The plugin therefore cancels its own wait and ignores late results rather than clearing a global dialog that another plugin may own. A host-owned dialog can remain visible after teardown, but its late approval cannot start capture.
- Concurrent Stops share one outcome, including calls from state observers; queued late cleanup cannot replace an in-flight Stop's promise. Failed Stop and failed cleanup of late Start admission release the uncertain connection and preserve an unconfirmed-stop message, including terminal notification before request rejection. A typed `not-joined` result does not claim shared capture ended, and an unjoined Stop cannot hide that result. Source selection joins the latest retirement before discovery and checks its barrier after each wait. A fresh selection can recover on a new connection.
- Offline lease regressions cover stalled connections without socket closure, one expired window alongside a healthy join, old-generation renewal, bounded startup, canceled acquisition waiters, and both mixed-version directions. Admission and shared Stop check deadlines at their atomic state decision, including revalidation that crosses the final lease deadline. A Start registers cancellation before waiting for expired native cleanup. Client tests cover one pending renewal, stalled replies, Stop fencing, rejected renewal, and no automatic Start replay. Canceling interest settles its exact pending renewal so later explicit Starts cannot exhaust the request budget. A generation watermark fences delayed statuses and control responses so they cannot clear or cancel a newer capture.
- Real daemon/socket/subprocess fixtures verify two explicit window joins, one synthetic helper, blocked retirement, stale PID rejection, and final-interest cleanup while a metadata-only client remains alive. They also pass with the generated native artifact removed, so they do not depend on a developer's local build.
- A separate native check passed more than 600 synthetic frames beyond 30 seconds through the real Swift helper, shared daemon, and negotiated client. It kept one helper and joined cleanup after final disconnection. Its catalog and source attribution remain fixtures; it does not verify real Kaset capture.
- The isolated OpenCode 2.0.24 TUI check verifies source confirmation, all styles, compact stereo resizing, one helper across style changes, Stop, stale selection, and style-only persistence after reload. It exposed a style-store dependency that recreated the slot and dropped its interest. Reading the initial style without tracking prevents that lifecycle regression. This local result does not broaden the pinned production host contract.

The synthetic checks above captured no live audio and changed no playback or personal plugin configuration. The separately approved live run passed sustained spectrum and explicit Stop in temporary configuration. Production packaging, signed distribution, shared-daemon live isolation, and the sustained soak remain release gates.

### 4. Local soak and release decision

Try the integrated package locally before merging. Keep the current prototype installation available until the replacement passes its checks. Repoint local configuration only deliberately, preserving unrelated plugins and avoiding duplicate visualizers.

Measure capture/analysis CPU, memory growth, dropped frames, signal age, and playback-command latency with one and multiple windows. Compare playback latency against capture-off operation under a stalled feature consumer. Record an idle/no-interested-view case and at least a 30-minute active soak. Logs contain lifecycle reasons and counters, not samples, waveform arrays, or private track metadata.

Maintain an evidence-based player/device matrix. CLIAMP is the initial verified source; other directly attributable apps require their own isolation checks. Kaset and browsers are not supported by inference. Unresolved sources remain unavailable rather than widening scope.

Run the gates in [CONTRIBUTING.md](../CONTRIBUTING.md), including workspace lint, type-checks, package tests, native compilation, package contents, packed-host smokes, and consumer audits. The full release gate remains `bun run check`. Do not broaden the [approved audit exception](dependency-audit.md).

An earlier 2026-10-09 offline run failed that full gate at `security:check`. The audit reported critical and high `seroval` advisories and a moderate `smol-toml` advisory. The [separate dependency follow-up](dependency-audit.md#serializer-and-toml-advisories) addressed those findings on main. The local-only PR retains main's dependency pins and lockfile. Its `da0debd9` checkpoint passed the full uncached gate and Windows, Linux, and macOS CI. Later review fixes require a new full gate and current-head CI; earlier green checks do not establish their correctness.

Production capture and distribution remain blocked until the integrated local test and release gates pass. A reviewed, default-off local implementation can merge separately without enabling or distributing capture. Prototype code and native executables stay excluded from production package contents. Publish a compatible music-core before dependent hosts, following the repository's release policy. This plan authorizes no merge, push, publication, or unattended capture; each requires a separate decision.
