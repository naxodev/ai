---
status: done
---

# Plan: finish the machine-local Effect v4 music-session migration

## Goal restatement

Continue from the current dirty Jujutsu worktree without resetting, cleaning, or replaying already verified work. Preserve the verified provider (`e7103663`), coordinator (`859fc01d`), scoped server (`66bc1f91`), executable boundary (`e70641bc`), negotiated protocol (`f059efc8`), truthful explicit client (`1411d281`), secure runtime-path (`ca96d66d`) commits, every unrelated change, and `docs/music-session-architecture.html`.

The dirty baseline already contains accumulated singleton/startup work in `config.ts`, `client.ts`, `server.ts`, `music-sessiond.ts`, and their focused tests: startup timing, exact-owner marker leases, detached launch, `connectOrStart`, listener-first acquisition, bind reservation, and same-process evidence. Retain it. The first three phases deliberately separate the abandoned combined gate:

1. fix only the selected production graph's blocked-work shutdown cycle;
2. prove only process-level two-daemon singleton winner/loser non-interference;
3. finish only the deterministic startup acceptance matrix.

Then complete reconnect, idle exit, bounded 24-client fan-out, native artwork ownership, OpenCode and Pi migration, cleanup, packed smokes, documentation, full-system verification, and a terminus PR-description artifact.

Use only the repository-pinned Effect TypeScript v4 APIs. Long-lived ownership belongs to Layers/scopes and supervised fibers; untrusted boundaries use `Schema`, runtime settings use `Config`, timing uses `Schedule`/`TestClock`, replayable state uses `SubscriptionRef`, and load-bearing paths use bounded queues/streams. Run planner/coder/reviewer roles through their configured Pi role profiles in regular panes. Follow the run's Jujutsu phase-child workflow: coding/review rounds do not commit or squash; after approval, the orchestrator squashes only the reviewed phase with `jj squash` before opening the next phase child. Never use Git commits, push, publish, open a PR, or edit `.apnea/state.json`.

Broad suites below are regression checks only. They do not make later-phase acceptance part of an earlier phase.

## Phases

### Phase 1 — Break only the selected production graph shutdown cycle

**Intent**

Refactor ownership so the real selected server graph cannot deadlock when a connection depends on blocked coordinator work. Listener, coordinator, and provider ownership must be distinct, with an explicit non-cyclic shutdown sequence: stop/refuse acceptance, interrupt coordinator work, await dependent connections, finalize provider ownership, then release the listener and its exact socket path.

**Files likely touched**

- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- The graph selected by both `startMusicSessionServer` and `runMusicSessionDaemon` has separate listener, coordinator, and provider scopes; no externally owned coordinator fixture bypasses production ownership.
- Binding/hardening still precedes provider/coordinator acquisition, and one shared graph constructor selects the same ownership topology for the Promise adapter and executable.
- Closing first marks the listener non-accepting/refuses late callbacks, then interrupts and joins coordinator work before draining connection children that can be waiting on it; provider finalization follows dependent connection completion, and listener close/exact-identity unlink completes last without a cycle.
- A real selected-topology test blocks sampling or transport through a real socket, closes the selected graph under a deterministic bound, and proves coordinator interruption, connection finalization, provider/event finalization, listener close/unlink, no late response, and no leaked socket/fiber.
- Existing bind reservation, singleton/startup, cleanup diagnostics, and listener-refusal behavior remain unchanged baseline regressions.

**Verify commands**

```sh
bun test packages/music-core/tests/session-server.test.ts -t 'selected.*blocked|blocked.*selected'
bun test packages/music-core/tests/session-server.test.ts
# Baseline regression only.
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n 'Effect\.runSync|setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
jj diff --summary
```

**Dependencies**

- The current dirty listener-first/bind-reservation implementation and all verified commits.
- Existing blocked provider/coordinator fixtures and real Unix-socket helpers.

**Non-goals**

- Process-level contender tests, marker/startup scheduling tests, 20-client convergence, or incompatibility races.
- Changing protocol, explicit client semantics, reconnect, idle exit, fan-out, artwork, hosts, packaging, or docs.
- Reworking already verified server lifecycle behavior beyond what the selected ownership-cycle fix requires.

### Phase 2 — Prove only process-level two-daemon singleton non-interference

**Intent**

Exercise socket bind as final singleton authority with two real daemon processes, separately from startup-marker and client-convergence behavior.

**Files likely touched**

- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- Two separately spawned daemon contenders race the same real Unix path while bypassing startup-marker coordination; exactly one process binds, acquires provider/coordinator ownership, and completes hello.
- The loser exits promptly, tagged/nonzero, before provider object, event subscription, polling, command worker, or foreground signal ownership.
- Loser cleanup cannot unlink, chmod, close, or replace the winner's socket/bind identity; a client can complete hello against the winner after the loser exits, and the winner remains healthy.
- Process output/counters make winner and loser ownership observable, and all subprocesses, sockets, temporary directories, reservations, and clients are released in `finally` on assertion failure.
- Same-process bind-race behavior and all Phase 1 shutdown behavior remain baseline regressions only.

**Verify commands**

```sh
bun test packages/music-core/tests/session-server.test.ts -t 'process.*daemon.*contender|daemon.*winner.*loser'
bun test packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 1's selected ownership graph.
- Existing executable injection seam, bind reservation, exact bound-path identity, and real hello helpers.

**Non-goals**

- `connectOrStart`, startup-marker races, TestClock pacing, 20-client convergence, incompatibility timing, reconnect, or idle shutdown.
- Adding a process supervisor, kill/replace policy, launchd integration, or remote sockets.

### Phase 3 — Finish only deterministic startup convergence and skew races

**Intent**

Complete the startup acceptance matrix on top of the now-correct process singleton. Keep live-loss reconnect for the next phase.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- The real retry workflow is paced with Effect `Schedule` under `TestClock`: no attempt occurs before its delay, delays cap correctly, success before exhaustion returns, exhaustion is a typed timeout, and interruption stops further attempts without wall-clock sleeps or busy loops.
- Twenty concurrent missing-endpoint `connectOrStart` calls, using real discovery/leases/listener/hello sockets and only an injected process-launch boundary, converge on one marker winner, one launch, one listener, one provider/event/coordinator/poll owner, and one daemon instance ID. Disposing one client does not affect the other nineteen.
- Exact-owner marker release is idempotent and runs after success, timeout, interruption, synchronous/initial spawn failure, and complete workflow failure. Replacement markers remain untouched; a primary failure remains primary while release diagnostics are retained and observable.
- A healthy incompatible generation observed before lease acquisition, after acquisition, or while waiting is terminal for that generation: one actionable range error, no further scheduled attempt, spawn, unlink, cleanup, signal, kill, or replacement; an already supported client stays healthy.
- Supported legacy/current clients share the started generation. Returned clients retain one-generation Phase 3 semantics and do not reconnect after live loss.
- Existing detached-launch options, secure runtime checks, opaque lease authority, and process singleton behavior remain baseline regressions.

**Verify commands**

```sh
bun test packages/music-core/tests/session-client.test.ts -t 'TestClock|20 concurrent|marker.*release|incompatib'
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts
jj diff --summary
```

**Dependencies**

- Phase 2's process singleton evidence and the accumulated secure discovery/lease/launcher workflow.
- Repository-pinned Effect v4 `Schedule`, `TestClock`, scoped finalizers, `Ref`, and deterministic random facilities.

**Non-goals**

- Reconnect supervision, retained state across generations, command replay, idle shutdown, fan-out load, artwork, or host behavior.
- Reopening Phase 1 ownership or Phase 2 process-contender acceptance unless a focused regression exposes a defect.

### Phase 4 — Supervise reconnect across daemon generations

**Intent**

Recover from genuine endpoint loss without replaying commands or accepting late work from an old generation.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- A scoped, supervised reconnecting client retains the last accepted state for presentation and uses bounded Effect scheduling after genuine socket loss.
- Every pending command settles exactly once as connection-lost/indeterminate and is never replayed.
- A replacement hello/replay with a new daemon instance is adopted; old-generation frames, callbacks, request completions, and reconnect attempts are ignored after generation change or disposal.
- Healthy incompatibility remains terminal and non-looping, with no endpoint replacement.
- The supported reconnecting API is exported for host adapters without exposing provider/server internals.

**Verify commands**

```sh
bun test packages/music-core/tests/session-client.test.ts -t 'reconnect|replacement generation|indeterminate'
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 3's convergent startup and truthful explicit-client semantics.

**Non-goals**

- Zero-client daemon exit, 24-client pressure, artwork, host UI feedback, or packed smokes.

### Phase 5 — Add zero-client idle shutdown

**Intent**

Complete daemon lifetime semantics independently of load hardening.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/tests/session-client.test.ts`

**Acceptance checks**

- Last-client departure starts one configurable idle grace period; a new completed connection cancels it; subsequent departures do not duplicate timers.
- Grace expiry follows the Phase 1 shutdown order, finalizes provider/listener exactly once, and removes only owned socket/marker/reservation artifacts.
- Signal, idle, startup-loss, and defect paths converge on one cleanup outcome; detached daemon handles do not keep hosts alive.
- Reconnecting clients can start/adopt the next generation after a genuine idle exit, while incompatibility remains terminal.
- Lifecycle diagnostics identify startup, client count, reconnect, incompatibility, provider degradation, and shutdown without logging playback/artwork payloads.

**Verify commands**

```sh
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t 'idle|last client|grace'
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 1 shutdown ordering and Phase 4 reconnect generations.

**Non-goals**

- Fan-out/backpressure, artwork, host migration, packaging, or docs.

### Phase 6 — Bound fan-out and prove 24-client operation

**Intent**

Meet the 20+ client requirement with bounded, isolated real-socket behavior.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`

**Acceptance checks**

- Inbound frames, per-client requests, global commands, pending responses, outbound state/status, and socket write pressure have explicit finite bounds.
- Pending state may coalesce per slow client without dropping command responses or required status transitions; abusive or irrecoverably slow clients are disconnected locally.
- Twenty-four alternating OpenCode/Pi identities receive hello replay and a later update while one provider object, event stream, coordinator, and poll owner remain active.
- One paused reader cannot delay the other twenty-three; cross-client commands remain globally FIFO, and queue overflow does not kill the daemon or healthy peers.

**Verify commands**

```sh
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t '24|slow reader|backpressure|overflow'
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phases 4–5 complete client and daemon lifetimes.

**Non-goals**

- Host controllers, remote/TCP access, durable history, artwork, or UI rendering.

### Phase 7 — Centralize and bound native artwork reads

**Intent**

Make the daemon the sole production owner of native `media-control get --now` artwork reads while keeping catalog lookup, conversion, and rendering in OpenCode.

**Files likely touched**

- `packages/music-core/system-media.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- A negotiated artwork capability/request validates the complete current recording identity before and after the native read and enforces a payload-size bound.
- Concurrent identical requests share one scoped Effect cache lookup; settled entries are capacity-bounded, and transient failures are not retained as successful cache values.
- Unsupported, stale, malformed, failed, disconnected, and disposed requests produce stable bounded outcomes without disrupting state fan-out.
- No iTunes lookup, download, image conversion, color/cell generation, Kitty rendering, or other host presentation moves into core.

**Verify commands**

```sh
bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts -t 'artwork|capability|payload'
bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 6's bounded protocol/client/server paths and existing provider authority.

**Non-goals**

- OpenCode cutover, Pi artwork, or presentation changes.

### Phase 8 — Introduce a tested OpenCode session adapter

**Intent**

Add a lightweight session-backed adapter and deterministic fake seam while leaving the current production selection intact for one green tactical step.

**Files likely touched**

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/artwork-lifecycle.test.ts`

**Acceptance checks**

- A session-client factory/fake drives replay, live state/status, controls, reconnect generations, disposal, and native artwork responses through existing controller contracts.
- Tests preserve loading, command feedback, local seek coalescing, waveform projection, artwork identity, and late-callback suppression without a real daemon.
- The adapter owns no provider, native probe, polling loop, sampling lane, playback clock, or global transport queue.
- Production remains on its current backend until Phase 9.

**Verify commands**

```sh
bun test --preload @opentui/solid/preload packages/opencode-music-player/tests/system-media.test.ts packages/opencode-music-player/tests/controller.test.ts packages/opencode-music-player/tests/controller-lifecycle.test.ts packages/opencode-music-player/tests/artwork-lifecycle.test.ts
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
jj diff --summary
```

**Dependencies**

- Phase 7's public reconnect/artwork client surface.

**Non-goals**

- Switching the production default, deleting the old backend, redesigning UI, Pi migration, or packed smoke.

### Phase 9 — Cut OpenCode production over

**Intent**

Select the session adapter in production and remove OpenCode's duplicate provider authority without presentation regressions.

**Files likely touched**

- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/artwork-lifecycle.test.ts`
- `packages/opencode-music-player/tests/package-load.test.ts`

**Acceptance checks**

- Loading OpenCode creates one session client and no host provider/probe/stream/poll/sample lane/playback clock/general command queue.
- Replay/live playing, paused, idle, replacement, disconnect, and incompatibility preserve controls, loading/errors/toasts, waveform, compact bar, and sidebar behavior.
- Native artwork comes through the daemon; identity-aware iTunes fallback, local cache/jobs, conversion, Kitty/half-block rendering, and completion events remain bounded and host-local.
- Disposal closes only this client, suppresses late state/command/artwork work, and leaves other clients healthy.

**Verify commands**

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
jj diff --summary
```

**Dependencies**

- Phase 8's tested adapter.

**Non-goals**

- Moving Solid/UI/catalog/rendering into core, changing controls or shortcuts, Pi migration, or final host smoke.

### Phase 10 — Migrate Pi and prove mixed-host command behavior

**Intent**

Replace Pi's backend/polling/transport ownership with one session client while retaining its status-line, waveform, command, reload, and notification behavior.

**Files likely touched**

- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/test/index.test.ts`
- `packages/pi-music-dock/package.json`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- A live Pi extension owns one client plus local waveform/status work, with no provider probe/retry/poll/sample lane/playback clock/general transport queue.
- `/music`, `/music-next`, `/music-prev`, and shortcuts route through the daemon and preserve per-call notifications and actionable disconnect/incompatibility feedback.
- Replay/live/replacement/disconnect preserve status and waveform; reload/shutdown marks the extension dead before disposal and ignores late work.
- Pi and OpenCode identities share one daemon global FIFO; closing/reloading Pi leaves OpenCode healthy.

**Verify commands**

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,pi-music-dock
! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision' packages/pi-music-dock/extensions/music-dock/index.ts
jj diff --summary
```

**Dependencies**

- Phase 6 mixed-identity behavior and Phase 9 OpenCode cutover.

**Non-goals**

- Pi artwork/seek, footer ownership, command renaming, packed smoke, or docs.

### Phase 11 — Remove migration scaffolding and finalize package surfaces

**Intent**

Delete obsolete host ownership only after both hosts are green, and finalize exports/manifests before packed-runtime certification.

**Files likely touched**

- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/tsconfig.json`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/package.json`
- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/package.json`
- `bun.lock`

**Acceptance checks**

- Obsolete host backend types, provider probes/retries, polling, sampling, playback clocks, and transport queues are gone; core's low-level `createSystemMedia()` remains an intentional compatibility export.
- Core exports and `bin`/`files` metadata include every daemon/client runtime file and exclude tests/scripts.
- Host metadata resolves `@naxodev/music-core` correctly and preserves exact host pins/ranges required by each host.
- No tarball, socket, marker, bind reservation, log, temporary install, or unintended build artifact remains in the worktree.

**Verify commands**

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player,pi-music-dock
(cd packages/music-core && npm pack --dry-run --ignore-scripts)
! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts packages/pi-music-dock/extensions/music-dock/index.ts
jj status
```

**Dependencies**

- Phases 9–10 host cutovers.

**Non-goals**

- Publishing/versioning, deleting core compatibility APIs, live host smoke, docs, or PR creation.

### Phase 12 — Prove the packed core daemon/client under Node

**Intent**

Turn core packing into an isolated installed-package Node lifecycle smoke.

**Files likely touched**

- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/session/music-sessiond.ts`

**Acceptance checks**

- The verifier builds and packs core, installs the tarball and dependencies into a temporary project, and resolves no workspace source.
- Installed client code starts/connects to the installed Node executable, completes negotiated hello/replay, disconnects, observes status-zero idle exit, and confirms owned socket cleanup.
- The test uses the packed executable selected by package metadata, not source or a PATH fallback.
- Temporary installs, tarballs, runtime artifacts, and child processes are cleaned on success and failure.

**Verify commands**

```sh
bunx nx run music-core:package:check
bunx nx run music-core:smoke
jj status
```

**Dependencies**

- Phase 5 idle exit and Phase 11 finalized package contents.

**Non-goals**

- OpenCode/Pi rendering, publishing, or documentation.

### Phase 13 — Certify the packed OpenCode plugin against its exact pin

**Intent**

Run the packed plugin with packed core against the exact OpenCode version declared by the manifest.

**Files likely touched**

- `packages/opencode-music-player/package.json`
- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/opencode-music-player/scripts/verify-pack.ts`
- `packages/opencode-music-player/tests/package-load.test.ts`

**Acceptance checks**

- An isolated install resolves packed OpenCode plugin and packed core with no workspace source.
- The smoke resolves and asserts the exact manifest-selected OpenCode executable/version rather than accepting an arbitrary PATH binary.
- The real plugin loads, renders expanded/collapsed/narrow app/sidebar states, and exercises session-backed replay/control presentation.
- Exit leaves no host process, daemon/provider handle, tmux session, tarball, socket, marker, reservation, log, or temporary install.

**Verify commands**

```sh
bunx nx run opencode-music-player:package:check
bunx nx run opencode-music-player:smoke
jj status
```

**Dependencies**

- Phases 9, 11, and 12.

**Non-goals**

- Updating to an unpinned OpenCode release, presentation redesign, Pi smoke, publishing, or PR creation.

### Phase 14 — Certify the packed Pi extension against its exact pin

**Intent**

Run the packed extension through the exact Pi version declared by the package and prove prompt process exit.

**Files likely touched**

- `packages/pi-music-dock/package.json`
- `packages/pi-music-dock/scripts/package-smoke.ts`

**Acceptance checks**

- An isolated install resolves packed Pi extension and packed core with no workspace source.
- The smoke resolves and asserts the exact manifest-selected Pi executable/version rather than accepting an arbitrary global binary.
- The extension loads in RPC mode and registers `/music`, `/music-next`, and `/music-prev` through the session-backed implementation.
- The host exits promptly without inherited daemon/provider handles and cleans tarballs/runtime/temp artifacts on success or failure.

**Verify commands**

```sh
bunx nx run pi-music-dock:package:check
bunx nx run pi-music-dock:smoke
jj status
```

**Dependencies**

- Phases 10–12.

**Non-goals**

- Pi artwork/seek, floating host versions, publishing, or PR creation.

### Phase 15 — Document the completed architecture

**Intent**

Update prose and the preserved architecture HTML only after behavior and packed smokes are settled.

**Files likely touched**

- `README.md`
- `packages/music-core/README.md`
- `packages/opencode-music-player/README.md`
- `packages/pi-music-dock/README.md`
- `docs/music-session-architecture.html`

**Acceptance checks**

- Documentation presents 20+ clients → one same-user Unix socket daemon → one provider as the current architecture, not a future path.
- It explains Effect services/Layers/scopes, selected shutdown order, replay/revisions, compatible and incompatible skew, singleton startup, global FIFO, bounds, reconnect without command replay, indeterminate commands, idle shutdown, native artwork ownership, diagnostics, and O(1) provider/O(N) fan-out costs.
- Host docs distinguish daemon authority from host-local UI, waveform, catalog, conversion, and rendering work.
- The HTML retains its skip link, labeled navigation/diagrams, source links, responsive/print behavior, reduced-motion support, and existing visual language.

**Verify commands**

```sh
bunx prettier --check README.md packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md docs/music-session-architecture.html
! rg -n 'Direct / current|Broker / scale path|future broker|when coordination is required' docs/music-session-architecture.html packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md
jj diff --summary
```

**Dependencies**

- Phases 1–14 define and certify the architecture being documented.

**Non-goals**

- New behavior, unrelated HTML redesign, publishing, or PR creation.

### Phase 16 — Run the full workspace and mixed-host release gate

**Intent**

Verify the accumulated migration as one system and make only narrow fixes exposed by this gate.

**Files likely touched**

- No product file is expected. If a gate exposes a defect, touch only the existing file that owns it and rerun that phase's focused checks before repeating this gate.

**Acceptance checks**

- `bun run check` passes, including format, policy, typecheck, unit/integration, parity, package, and smoke targets.
- On macOS with provider tooling, one exact-pinned OpenCode host and one exact-pinned Pi host show the same track; commands from either converge in both; one PID/socket/provider serves them; reload does not duplicate ownership.
- Daemon replacement recovers without command replay; missing tools and incompatibility yield actionable feedback; final disconnect releases daemon/provider and owned artifacts after idle grace.
- `docs/music-session-architecture.html` passes a browser visual/accessibility spot check.
- The worktree contains no generated/runtime debris; every pre-existing unrelated change and `.apnea/state.json` is preserved.

**Verify commands**

```sh
bun run check
bunx nx run opencode-music-player:smoke
bunx nx run pi-music-dock:smoke
jj diff --summary
jj status
```

**Dependencies**

- Phases 1–15.

**Non-goals**

- Feature expansion, publishing, tagging, pushing, opening a PR, or unrelated cleanup.

### Phase 17 — Produce the terminus PR description artifact

**Intent**

When dispatched at terminus, write the PR description to the exact artifact path supplied by that dispatch; do not create or update a pull request.

**Files likely touched**

- Only the dispatcher-provided PR-description artifact; no product source.

**Acceptance checks**

- Front matter contains `status: done` only.
- The description accurately summarizes delivered phases, user-visible architecture, Effect ownership, protocol/lifecycle guarantees, host migrations, test plan, exact-pinned packed/manual evidence, and residual risk.
- Claims match Jujutsu history/diff and do not claim a push, publication, or opened PR.

**Verify commands**

```sh
jj log -r 'ancestors(@, 24)' --no-graph -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"'
jj diff --summary
jj status
```

**Dependencies**

- Approved Phase 16 evidence and the terminus dispatch's exact artifact path.

**Non-goals**

- Product edits, commits, pushes, publishing, or opening/updating a PR.

## Whole-run definition of done

- Every verified commit, all accumulated singleton/startup work, unrelated dirty content, and `docs/music-session-architecture.html` are preserved and extended rather than reset.
- The selected production graph has separate listener/coordinator/provider ownership and deterministically shuts down blocked real-socket work in the required non-cyclic order.
- Separate daemon processes prove one socket/provider winner, a tagged/nonzero zero-provider loser, and loser non-interference with the winner.
- Effect `TestClock` proves bounded startup pacing; twenty concurrent first users converge on one generation; exact marker release and incompatibility races are complete.
- Reconnect adopts only replacement generations and never replays commands; zero-client idle shutdown releases provider/listener and owned runtime artifacts exactly once.
- A real 24-client scenario proves one provider/event/poll owner, immediate replay, one global FIFO, bounded memory/queues, and slow-reader isolation.
- Native artwork reads are daemon-owned, identity-checked, deduplicated, and bounded; catalog lookup and rendering remain OpenCode-local.
- OpenCode and Pi own only lightweight clients and local presentation; existing controls, feedback, waveform, artwork, reload, and teardown behavior remain green.
- Core, OpenCode, and Pi packed-install smokes resolve no workspace source, use Node/exact pinned hosts as applicable, and exit without leaked handles or artifacts.
- The preserved architecture HTML and READMEs document the completed current topology and retain accessibility/responsive behavior.
- `bun run check`, exact-pinned host smokes, and the real mixed-host macOS check pass; `jj status` contains no generated/runtime debris.
- Phase work uses configured Pi role profiles in regular panes and the prescribed reviewed-child `jj squash` workflow. Nothing is committed with Git, pushed, published, or opened as a PR, and `.apnea/state.json` is not edited.
- The terminus PR-description artifact is complete at the path supplied by its dispatch.
