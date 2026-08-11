---
status: done
---

# Plan: complete the machine-local Effect music-session migration

## Goal restatement

Finish the existing dirty-worktree migration from one media provider per OpenCode/Pi process to one same-user, machine-local music-session daemon serving at least 20 concurrent clients. Preserve all accumulated source changes and `docs/music-session-architecture.html`; refine the current `packages/music-core/session/` implementation in place rather than resetting it.

The daemon must be owned by one Effect TypeScript v4 runtime: services and Layers define boundaries, provider/listener/socket resources are scoped, long-lived work is supervised, replay uses Effect state/stream primitives, timing is deterministic under `TestClock`, expected boundary failures are schema-tagged, and runtime settings pass through Effect `Config`. The final clients use a schema-validated, revision-negotiated Unix-socket protocol while retaining existing controls, feedback, waveform, artwork, reload, and cleanup behavior.

Do not commit with Git, push, publish, open a PR, or edit `.apnea/state.json`.

## Current-tree findings and execution discipline

- The working copy already contains substantial uncommitted daemon/client code in `packages/music-core/session/`, package/bin changes, Effect `4.0.0-beta.101`, tests, and the intentional architecture HTML. All are inputs, not disposable generated work.
- The latest abandoned review identified four concrete unfinished seams: optimistic command projection can overwrite a newer provider snapshot; the sliding mixed provider-event buffer cannot guarantee terminal invalidations and latest snapshots; synchronous attempt acquisition bypasses `ProviderError`; and socket close/unlink failures are discarded. Deterministic evidence is also missing for the coordinator and connection races.
- Keep daemon, protocol, client, and host-neutral state in `@naxodev/music-core`. Both hosts already depend on it; another package would add a release boundary without reducing authority.
- Keep `createSystemMedia()` as a public compatibility surface. “Removal” below means removing duplicate provider/poll/sample/transport ownership from the two hosts, not deleting the low-level export.
- The last abandoned run reported the current focused and package gates green. Each phase must preserve that baseline while adding only evidence for its own seam.
- Use Effect v4 APIs only. Promise/callback facades are permitted at public Node/host boundaries, but may not own daemon work.
- Follow the repository’s Jujutsu squash workflow: perform each phase in a fresh child change, inspect `jj diff --summary`, and only after phase acceptance use `jj squash` to fold that phase into the accumulated run change before starting the next child. Do not use `git commit`, disturb unrelated paths, or push.

## Phases

### Phase 1 — Provider attempt lifecycle and bounded event bridge

**Intent**

Finish only the provider boundary. Make one raw provider attempt, bounded callback-to-Effect delivery, retry pacing, and provider errors independently correct before coordinator or server acceptance is considered.

**Implementation outline**

1. Preserve one `createSystemMediaAdapter()` clock shared by sample, transport, and stream decoding. Keep legacy `createSystemMedia()` retry behavior unchanged for hosts not yet migrated.
2. Make the one-attempt seam start exactly one `media-control stream --no-diff --no-artwork`, emit complete snapshots, report one terminal invalidation, own no retry timer, and dispose child/listeners exactly once.
3. Replace the current lossy mixed sliding buffer with an explicitly bounded coalescing/prioritization design. It must retain the latest complete snapshot while guaranteeing each terminal transition causes one immediate invalidation; neither event class may evict the other’s required signal.
4. Map synchronous attempt acquisition, callback-source startup, sample, transport, and source failures once into `ProviderError` (`Schema.TaggedErrorClass`). Preserve defects and interruption rather than relabeling them.
5. Supervise attempts in the provider Layer with an Effect `Schedule`: 1/2/4/8/8-second delays, reset to one second after a valid snapshot. Interruption must cancel retry sleep or an active attempt and suppress late callbacks.
6. Add focused tests with `TestClock`, Effect synchronization primitives, and acquisition/disposal counters. Do not rely on coordinator/server tests or wall-clock sleeps for this phase.

**Files likely touched**

- `packages/music-core/system-media.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/system-media.test.ts`

**Acceptance checks**

- One provider Layer acquisition creates one adapter and at most one active raw stream attempt; all source/provider finalizers run exactly once.
- A saturated bridge still delivers the latest authoritative snapshot and one invalidation per terminal transition with bounded memory.
- Attempt startup throws and terminal failures are tagged `ProviderError`s and do not permanently kill retry supervision.
- `TestClock` proves capped 1/2/4/8/8 retries, reset after success, and interruption during active/retry states.
- The one-attempt seam owns no raw retry timer; all existing low-level fallback, complete-payload, shared-clock, and legacy retry tests remain green.

**Verify commands**

```sh
bun test packages/music-core/tests/system-media.test.ts
bunx nx run-many -t typecheck test format:check package:check --projects=music-core
! rg -n "setTimeout\(|setInterval\(" packages/music-core/session/provider.ts
jj diff --summary
```

**Dependencies**

- Current `system-media.ts` normalization, fallback provider behavior, and playback clock.
- Pinned Effect v4 and `effect/testing`.

**Non-goals**

- Coordinator authority, polling, commands, sockets, protocol changes, process lifecycle, or host migration.

### Phase 2 — Coordinator atomic authority, polling, reconciliation, and global commands

**Intent**

Make the coordinator the sole atomic state and command authority. This phase is accepted entirely with an Effect-native fake provider Layer and does not require a socket or client.

**Implementation outline**

1. Complete the `MusicSessionConfig` Context service and shared validation path for queue capacity, frame size, reconciliation delays, and 3/5/8-second polls. Concrete test options and `ConfigProvider` acquisition must produce the same typed result; malformed values fail as `MusicSessionConfigError`.
2. Use `SubscriptionRef` for replayable provider status and revisioned state. Complete snapshots replace state immediately; samples merge through existing reconciliation behavior.
3. Implement a single-flight sampling lane with atomic generation/authority checks: overlapping triggers stale the active sample and coalesce to one catch-up; pre-snapshot, pre-trigger, and pre-command samples cannot publish.
4. Fix optimistic play/pause/seek projection by transforming the current `SubscriptionRef` value inside one atomic transition. Never publish a full state captured before a concurrent provider snapshot. Navigation advances authority without inventing replacement metadata.
5. Keep one bounded Effect `Queue` and one scoped global command worker. Resolve `toggle` at dequeue time; continue after provider failure or saturation; settle active and queued callers exactly once on interruption.
6. Drive 3/5/8-second polling and transport/navigation reconciliation with Effect time/Schedules. Every accepted update atomically replaces the applicable deadline.
7. Replace conventional coordinator errors with schema-tagged command errors and preserve provider causes/interruption.
8. Add an Effect-native deterministic fake Layer using `Deferred`, `Queue`, `Ref`, or `Latch`; retain the Promise fake only where later socket compatibility tests need it.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/session-coordinator.test.ts`

**Acceptance checks**

- Late status/state subscribers receive the current value first and then ordered updates.
- Complete snapshots publish without sampling; invalidation bursts yield one discarded stale sample and one catch-up.
- Tests reproduce and prevent snapshot-vs-optimistic-command, trigger-vs-publication, deadline replacement, and scope-close enrollment races.
- `TestClock` proves playing/paused/idle polls at 3/5/8 seconds, deadline reset, and distinct transport/navigation reconciliation delays.
- Cross-submitter commands execute FIFO; two rapid toggles call play then pause; successful play/pause/seek project centrally without rolling back newer metadata.
- One command failure requests recovery and leaves the worker usable; overflow is typed and bounded; blocked work is interrupted and every caller settles once.
- Coordinator tests use the Effect-native fake Layer and do not require server behavior.

**Verify commands**

```sh
bun test packages/music-core/tests/session-coordinator.test.ts
bunx nx run-many -t typecheck test format:check package:check --projects=music-core
! rg -n "Effect\.runSync|setTimeout\(|setInterval\(" packages/music-core/session/coordinator.ts
jj diff --summary
```

**Dependencies**

- Phase 1 provider service, event guarantees, and tagged failures.

**Non-goals**

- Unix sockets, expanded wire schemas, reconnect, auto-start, or host behavior.

### Phase 3 — Scoped foreground socket server and connection ownership

**Intent**

Make the current explicit-socket foreground server a genuinely scoped Effect slice. Preserve the existing wire behavior; protocol expansion belongs to Phase 4.

**Implementation outline**

1. Acquire `net.Server`, the successfully bound path, accepted sockets from acceptance onward, Node listeners, input queues, framers, and each connection’s forwarding fibers through scopes/Layers.
2. Enroll connection work in `FiberSet` or equivalent supervised Effect ownership directly from the accept bridge. Pre-hello and mid-frame sockets must be owned just like handshaken clients.
3. Keep current hello-first, replay, state, and transport behavior while decoding all ingress at the existing protocol boundary.
4. Surface listen, close, and non-`ENOENT` unlink failures as `MusicSessionSocketError` while continuing the remaining finalizers. Never silently discard stale-path cleanup failure.
5. Make repeated close idempotent. Server scope closure interrupts connection forwarding and blocked coordinator calls, destroys sockets, closes the listener, unlinks only its own bound socket, and releases coordinator/provider once.
6. Run the production Layer graph directly in `music-sessiond.ts`; signal registration is scoped. The test-facing `startMusicSessionServer` remains only a Promise adapter over one Effect scope.
7. Add deterministic cleanup instrumentation rather than inferring resource release from elapsed time.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`

**Acceptance checks**

- One Layer graph acquires one provider, one event source, one coordinator, and one Unix listener.
- Two explicit clients receive initial status/state and a provider update, and their commands pass through the one coordinator FIFO.
- Closing with a pre-hello socket, active forwarding, blocked sample, or blocked command completes with exact-once resource finalization and no late writes.
- Repeated close is harmless; listen/close/unlink errors retain typed operation context and do not skip other cleanup.
- No detached Promise loop, raw timer, or isolated `Effect.runSync` owns daemon work.

**Verify commands**

```sh
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts packages/music-core/tests/system-media.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n "Effect\.runSync|setTimeout\(|setInterval\(" packages/music-core/session/coordinator.ts packages/music-core/session/provider.ts packages/music-core/session/server.ts
jj diff --summary
```

**Dependencies**

- Phase 1 provider and Phase 2 coordinator Layers.

**Non-goals**

- Revision-range negotiation, reconnect, automatic process launch, 24-client capacity, or host migration.

### Phase 4 — Shared validated protocol and explicit client

**Intent**

Finish a manually started end-to-end contract before automating daemon lifecycle.

**Implementation outline**

1. Define requests, events, responses, provider/device/track state, capabilities, revision ranges, and stable errors with Effect `Schema`; decode unknown input at both client and server boundaries and remove parallel manual validators/casts.
2. Negotiate protocol major plus supported revision interval and capability intersection, selecting the highest overlap. Package version remains diagnostics, not compatibility. The initial revision supports itself; additive evolution retains the immediately preceding revision.
3. Return actionable incompatibility data containing both ranges. Rejecting an incompatible client must not disturb the healthy daemon or existing clients.
4. Preserve immediate status/latest-state replay with daemon instance ID and monotonic revision. Reject wrong-instance, stale, duplicate, out-of-order, malformed, oversized, and incomplete frames.
5. Enforce hello-first ordering, strictly increasing request IDs, capability/action checks, seek bounds, and stable success/failure envelopes.
6. Make the explicit client correlate responses, isolate listener exceptions, dispose idempotently, and settle every pending call once. A lost connection before a command response reports an indeterminate result; commands are never replayed.

**Files likely touched**

- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- Overlapping old/current wire ranges negotiate one revision and share the existing provider; disjoint ranges receive one actionable typed failure while healthy peers remain connected.
- Schema decoding rejects malformed nested state/errors, invalid actions/seeks, missing capabilities, duplicate IDs, oversized frames, and incomplete lines without crashing the listener.
- Replay and subsequent broadcasts are ordered; stale/wrong-instance snapshots and unsolicited/duplicate responses are ignored or terminate the offending connection as specified.
- Pending calls settle once on response, disposal, malformed daemon data, and disconnect; indeterminate commands are not retried.
- Provider failure/queue overflow remain typed and do not strand later FIFO work.

**Verify commands**

```sh
bun test packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 3 foreground server and cleanup semantics.

**Non-goals**

- Runtime-directory discovery, process spawning, reconnect, idle exit, artwork, or host migration.

### Phase 5 — Secure same-user singleton startup and version-skew policy

**Intent**

Add race-safe discovery and automatic startup without yet requiring reconnect/load-hardening evidence.

**Implementation outline**

1. Resolve a short per-user runtime directory/socket under `/tmp` to remain below macOS Unix-socket limits. Require owner-only directory permissions and reject symlinks, foreign ownership, and unexpected file types.
2. Implement `connectOrStart` as an Effect workflow: probe and complete hello first; only missing or safely identified stale endpoints may enter startup.
3. Coordinate launchers with an exclusively created startup marker while keeping socket bind as singleton authority. Spawn the packaged daemon detached with no inherited host stdio/handles and wait with a bounded jittered `Schedule`.
4. A losing daemon exits before acquiring a provider. Remove only artifacts proven to belong to this user/start attempt.
5. Treat incompatibility with a healthy socket generation as terminal: no unlink, kill, replacement spawn, or reconnect loop. A later explicit retry may proceed only after that generation disappears or becomes compatible.
6. Add real Unix-socket concurrent-start tests with instrumented provider acquisition.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- Concurrent first-use attempts produce one bound listener, one provider object, and at most one provider stream/poll owner.
- Detached launch inherits no host stdio/handle that keeps OpenCode or Pi alive.
- Owned stale socket/marker artifacts recover; symlinked, foreign-owned, non-socket, and healthy incompatible endpoints are never removed.
- Supported mixed clients join the live daemon; an unsupported client gets one actionable error with zero kill/unlink/replacement/retry-loop attempts.

**Verify commands**

```sh
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 4 negotiated protocol and explicit client.

**Non-goals**

- Reconnect after a live loss, idle shutdown, slow-reader isolation, 24-client proof, host migration, or packed-install smoke.

### Phase 6 — Reconnect generations and zero-client shutdown

**Intent**

Complete process replacement and idle lifetime semantics independently of scale/backpressure.

**Implementation outline**

1. Supervise reconnect with bounded backoff only after genuine endpoint loss. Retain the last accepted state for presentation while reconnecting.
2. Settle in-flight requests truthfully as connection-lost/indeterminate, never replay a command, and admit replacement replay under a new daemon generation.
3. Reject late frames, callbacks, and completions from superseded socket/daemon generations.
4. Track live connection scopes and exit after a configurable zero-client grace period. New clients cancel the pending idle exit.
5. Ensure signals, idle exit, startup loss, and defects close clients, provider, listener, schedules, and owned runtime artifacts exactly once.
6. Add lifecycle diagnostics for startup, incompatibility, provider degradation, reconnect, client count, and shutdown without logging playback/artwork payloads.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- Killing the daemon settles pending calls once, starts/finds one replacement, adopts its replay, and ignores old-generation data without replaying commands.
- Incompatibility remains non-looping and does not trigger replacement.
- Closing the last client starts one idle deadline; reconnect before expiry cancels it; expiry releases provider/listener and removes owned artifacts.
- Signal and defect paths have the same exact-once cleanup guarantees and leave no inherited process handles.

**Verify commands**

```sh
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 5 singleton discovery/startup.

**Non-goals**

- Slow-client backpressure, 24-client proof, artwork, host UI behavior, or packaging smoke.

### Phase 7 — Bounded fan-out and 24-client operation

**Intent**

Prove the daemon remains bounded and responsive at the target concurrency without making host migration part of the gate.

**Implementation outline**

1. Bound per-client in-flight requests, inbound frames, global command depth, outbound response/event buffering, and socket write pressure.
2. Coalesce pending state snapshots per slow client while preserving command responses and status transitions required by the protocol.
3. Disconnect abusive or irrecoverably slow clients rather than blocking provider work or healthy peers.
4. Add a real-socket scenario with at least 24 alternating OpenCode/Pi identities covering replay, fan-out, cross-client FIFO, a paused reader, provider failure, and reconnect.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- Twenty-four clients receive initial replay and a later provider update while one provider/stream/poll owner remains active.
- One paused reader cannot delay the other 23; memory and queues remain within configured bounds.
- Commands from all identities execute in one observed FIFO; overflow affects only the responsible request/client and the worker continues.
- Reconnect and mixed-version behavior from Phases 4–6 remain correct under concurrent load.

**Verify commands**

```sh
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 6 reconnect and idle lifetime semantics.

**Non-goals**

- Host controllers, artwork rendering, remote/TCP access, multi-user sharing, or durable history.

### Phase 8 — Centralize native artwork reads

**Intent**

Make the daemon the only production owner of native `media-control` artwork reads before OpenCode stops creating its local provider. Keep catalog lookup and rendering host-local.

**Implementation outline**

1. Add a negotiated native-artwork request/capability to the validated protocol and client.
2. Validate the requested recording identity against current authoritative state before and after the native read, bound payload size, and return typed unavailable/stale results.
3. Deduplicate concurrent identical reads and bound settled cache entries without allowing unresolved work to be evicted incorrectly.
4. Invoke `media-control get --now` only behind the daemon provider boundary. Keep iTunes lookup, download, image conversion, color/cell generation, and Kitty rendering out of core.
5. Add deterministic provider/server/client tests for identity changes, deduplication, bounds, failure, disconnect, and disposal.

**Files likely touched**

- `packages/music-core/system-media.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- Concurrent identical requests across clients produce one native provider read.
- Artwork is accepted only for the still-current full recording identity and stays within configured payload/cache limits.
- Unsupported provider/capability, stale identity, malformed data, and disconnect return stable bounded failures without affecting state fan-out.
- No catalog/network/rendering concern moves into the daemon.

**Verify commands**

```sh
bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 7 bounded protocol and provider authority.

**Non-goals**

- OpenCode controller migration itself, Pi artwork, or UI changes.

### Phase 9 — Migrate the OpenCode client and preserve presentation

**Intent**

Replace OpenCode’s provider/sampling/transport ownership with one lightweight production session client while preserving controller, artwork, waveform, and UI behavior.

**Implementation outline**

1. Refactor the OpenCode system-media facade and controller to consume session replay/live state and provider/connection status and to route controls through the daemon.
2. Remove host-owned provider creation, stream restart, 3/5/8 polling, stale-sample authority, playback clock, and general transport FIFO. Keep adjacent seek coalescing only as local input optimization with every caller settled.
3. Fetch native artwork through the daemon capability; retain identity-aware iTunes fallback, bounded local artwork jobs/cache, image conversion, Kitty/half-block rendering, and completion events.
4. Preserve loading semantics based on local pending calls, toast/error behavior, compact/sidebar rendering, shortcuts, and host integration contracts.
5. On disconnect retain the last view and show bounded actionable feedback; converge from replay. Disposal suppresses late state/command/artwork work and closes only this client.
6. Rewrite controller/lifecycle/system-media tests around a deterministic fake session client and update the existing package smoke to install packed core.

**Files likely touched**

- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/package.json`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/package-load.test.ts`
- `packages/opencode-music-player/tests/artwork-lifecycle.test.ts`
- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/opencode-music-player/scripts/verify-pack.ts`

**Acceptance checks**

- Loading OpenCode creates one session client and no host provider, provider stream, provider poll, sample lane, playback clock, or general command queue.
- Replay/live playing, paused, idle, replacement, and enriched artwork states preserve current UI, waveform, controls, loading, errors, and toast behavior.
- Rapid local seeks retain prior coalescing while actual transport remains daemon-global FIFO.
- Native identity checks, iTunes fallback, cache bounds, Kitty/half-block rendering, and teardown remain green.
- Disconnect/reconnect retains and then converges the view; incompatibility does not cause spawn/retry storms; teardown leaves other clients healthy.
- Packed OpenCode resolves packed core and renders the real app/sidebar smoke fixture.

**Verify commands**

```sh
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core,opencode-music-player
bunx nx run opencode-music-player:smoke
! rg -n "createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision" packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
jj diff --summary
```

**Dependencies**

- Phase 8 native artwork request and the production session client lifecycle.

**Non-goals**

- Moving catalog lookup, rendering, Solid state, or layout into the daemon; changing controls or shortcuts; Pi migration.

### Phase 10 — Migrate Pi and prove mixed-host behavior

**Intent**

Move Pi to the same lightweight client, preserve its status/waveform lifecycle, and prove both host identities coexist without duplicate ownership.

**Implementation outline**

1. Replace the injected `MusicBackend` test seam with an injected session-client factory/fake.
2. On `session_start`, project replay/live state and status into the existing waveform/status path; Pi must not probe or start provider binaries.
3. Route `/music`, shortcut toggle, next, and previous through daemon commands while preserving per-call notifications.
4. Remove local sample/retry/poll/revision/transport queue logic. On reload/shutdown mark the session dead before disposing subscriptions, client, waveform, and status so late work is ignored.
5. Rewrite lifecycle/ordering tests and update the existing package smoke to install packed core and exit without inherited daemon/provider handles.
6. Extend mixed-host coverage so commands from either real host adapter update both.

**Files likely touched**

- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/test/index.test.ts`
- `packages/pi-music-dock/package.json`
- `packages/pi-music-dock/scripts/package-smoke.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- A live Pi session owns one client and local waveform/status work, but no provider, probe, subscription, poll, sample lane, playback clock, or transport queue.
- Replay/live playing, paused, idle, enrichment, and replacement preserve status and waveform behavior.
- Pi/OpenCode commands are globally FIFO; repeated toggles alternate from daemon state and all callers settle.
- Reload/shutdown clears local presentation, ignores old completions/events, closes only Pi’s client, and leaves OpenCode healthy.
- Missing tools, unsupported platform, reconnect, incompatibility, and command failure notify without crash or retry/spawn storm.
- The packed Pi extension registers all commands and exits promptly without inherited provider/daemon handles.

**Verify commands**

```sh
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core,pi-music-dock
bunx nx run pi-music-dock:smoke
! rg -n "createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision" packages/pi-music-dock/extensions/music-dock/index.ts
jj diff --summary
```

**Dependencies**

- Phase 7 client lifecycle and Phase 9 exercised mixed-host counterpart.

**Non-goals**

- Seek/artwork in Pi, footer replacement, command/shortcut renaming, or shared waveform rendering state.

### Phase 11 — Remove duplicate host ownership and finish manifests/smokes

**Intent**

Remove migration scaffolding only after both hosts are green, then prove packed Node and host boundaries. Retain the documented low-level core compatibility API.

**Implementation outline**

1. Delete now-unused host backend types, constructor injections, poll/retry/sample/transport helpers, and obsolete tests; keep `createSystemMedia()` exported from core for external compatibility, with the daemon as its sole production caller in this workspace.
2. Finalize core exports, bin/files lists, dependency metadata, Nx targets, and pack assertions for every required daemon/client runtime file while excluding tests/scripts.
3. Extend the existing core pack verifier/target to build and pack core, install the tarball and dependencies into an isolated temporary project, start the installed daemon with `node`, perform hello/replay through the installed client, disconnect, and assert status-zero idle exit plus socket cleanup. It must not resolve workspace source.
4. Ensure OpenCode and Pi smokes install packed core, use no workspace-only resolution, and leave no inherited daemon handle.
5. Remove generated tarballs, sockets, markers, logs, and untracked build output after each smoke.

**Files likely touched**

- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/tsconfig.json`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/package.json`
- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/opencode-music-player/scripts/verify-pack.ts`
- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/package.json`
- `packages/pi-music-dock/scripts/package-smoke.ts`
- `bun.lock`

**Acceptance checks**

- No production host file directly creates/probes the provider or owns provider retry, polling, stale sampling, playback clock, or a general transport queue.
- Core’s package contains the executable and all client/session runtime files, excludes development files, and retains intended low-level public exports.
- An isolated tarball install starts the real executable under Node, handshakes/replays through installed client code, exits after disconnect, and removes its socket.
- Packed OpenCode and Pi resolve packed core and exit without leaked handles.
- No generated package/runtime artifacts remain in the working copy.

**Verify commands**

```sh
bunx nx run-many -t build typecheck test format:check package:check smoke --projects=music-core,opencode-music-player,pi-music-dock
(cd packages/music-core && npm pack --dry-run --ignore-scripts)
! rg -n "createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision" packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts packages/pi-music-dock/extensions/music-dock/index.ts
jj status
```

**Dependencies**

- Phases 9–10 completed host migrations and Phase 6 idle shutdown.

**Non-goals**

- Publishing, versioning, deleting the low-level core provider compatibility surface, or documentation edits.

### Phase 12 — Update current-architecture docs and run final verification

**Intent**

Document only the completed architecture, preserve the existing HTML’s design/accessibility, and run the whole workspace and mixed-host checks.

**Implementation outline**

1. Document core daemon/client use, same-user socket security, singleton startup, revision/capability negotiation, supported/unsupported skew, reconnect without command replay, command indeterminacy, bounds, diagnostics, and idle shutdown.
2. Update both host READMEs and the root package description to distinguish daemon authority from host-local presentation.
3. Edit `docs/music-session-architecture.html` in place. Present 20+ clients → one same-user Unix socket daemon → one provider as current. Cover Effect services/Layers/scopes, replay/revisions, compatibility, global FIFO, bounded fan-out, reconnect, idle lifetime, native artwork ownership, O(1) provider cost, O(N) fan-out, and client-local UI/waveforms/catalog/rendering.
4. Preserve skip link, labeled navigation/diagrams, source links, responsive/print rules, reduced-motion behavior, and existing visual language.
5. Run the full workspace gate and manually exercise one OpenCode and one Pi instance against the same daemon on macOS. Inspect rather than modify unrelated dirty files.

**Files likely touched**

- `README.md`
- `packages/music-core/README.md`
- `packages/opencode-music-player/README.md`
- `packages/pi-music-dock/README.md`
- `docs/music-session-architecture.html`

**Acceptance checks**

- No documentation presents independent host providers/polls as current or the daemon as a future option.
- Compatibility guidance says supported mixed versions share the healthy daemon; unsupported skew never replaces it and receives actionable convergence guidance.
- The HTML remains intentional worktree content with its accessibility, responsive, print, and source-link behavior intact.
- In a real mixed-host check, both hosts show the same track, controls from either converge in both, one PID/socket/provider serves them, reload does not duplicate ownership, and final disconnect releases daemon/provider after idle grace.
- Missing provider tools and daemon restart produce actionable feedback and recover when prerequisites return.
- Full checks pass; no tarball, socket, marker, log, or newly tracked generated output remains; unrelated changes and `.apnea/state.json` are untouched.

**Verify commands**

```sh
bunx prettier --check README.md packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md docs/music-session-architecture.html
! rg -n "Direct / current|Broker / scale path|future broker|when coordination is required" docs/music-session-architecture.html packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md
bun run check
jj status
```

Manual documentation/live check:

```sh
python3 -m http.server 8000
# Open http://localhost:8000/docs/music-session-architecture.html, then run one OpenCode and one Pi TUI against the same machine-local session.
```

**Dependencies**

- Phases 1–11 define the architecture and packed behavior to document.
- macOS, provider tooling, the repository-pinned OpenCode CLI, and Pi for the live check.

**Non-goals**

- Publishing, tagging, committing, pushing, opening a PR, launchd installation, remote daemon management, or unrelated HTML redesign.

## Whole-run definition of done

- `@naxodev/music-core` ships a Node-compatible machine-local daemon and lightweight client with a schema-validated, revision-negotiated, bounded Unix-socket protocol.
- Context services, Layers, scopes, supervised fibers/streams, `SubscriptionRef`, bounded queues, `Schedule`, `Config`, and schema-tagged failures—not imperative wrappers—own provider, listener, sockets, event flow, command lane, polling, retries, and shutdown.
- Deterministic tests prove provider bridge/retry semantics, all coordinator authority races, 3/5/8 polling, reconciliation, exact-once cleanup, and interruption of blocked work.
- Concurrent first use safely creates one same-user daemon. Supported mixed versions share it; unsupported versions cannot unlink, kill, replace, or loop against it.
- A 24-client scenario proves one provider/stream/poll owner, immediate replay, bounded slow-reader isolation, and one cross-client FIFO.
- Reconnect adopts replacement replay, rejects old generations, settles pending commands truthfully, and never replays an indeterminate command; zero-client shutdown removes owned artifacts.
- Native provider artwork reads are centralized, identity-checked, bounded, and deduplicated. OpenCode retains catalog/rendering work; Pi and both hosts retain only local presentation state.
- OpenCode and Pi no longer own provider creation/probes, provider retries, fallback polling, stale sample lanes, playback clocks, or general transport queues, and each tears down only its client/presentation work.
- Existing complete snapshots, coalesced recovery, fallback provider behavior, controls, feedback, waveform, artwork cache/rendering, reload, and shutdown semantics remain green at their new owners.
- Isolated packed-install smokes run the daemon under Node, resolve packed core from both hosts, and exit without leaked handles or workspace source resolution.
- `docs/music-session-architecture.html` is preserved and accurately presents the daemon topology as current.
- `bun run check` and the mixed-host macOS check pass; no generated/runtime artifacts remain; unrelated worktree changes are preserved; no push, PR, publish, Git commit, or `.apnea/state.json` edit occurs.
