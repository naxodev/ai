---
status: done
---

# Plan: finish the machine-local Effect music-session migration

## Goal restatement

Finish the existing machine-local music-session migration without resetting the current tree. Preserve the verified provider commit (`e7103663`), verified coordinator commit (`859fc01d`), the accumulated scoped-server work now present in `66bc1f91`, all unrelated changes, and `docs/music-session-architecture.html`. Complete the three unresolved server boundaries first, then deliver the negotiated protocol, secure singleton lifecycle, reconnect and idle shutdown, bounded 24-client fan-out, centralized native artwork, OpenCode and Pi migrations, packing, documentation, pinned host smokes, final checks, and a PR-description artifact.

Use only the repository-pinned Effect TypeScript v4 APIs. Long-lived work belongs to Layers/scopes and supervised fibers; use `Schema` at untrusted boundaries, `Config` for runtime settings, `Schedule` for timing, `SubscriptionRef` for replayable state, bounded queues/streams for flow control, and Effect synchronization primitives/TestClock for deterministic tests.

Do not use Git commits, push, publish, open a PR, or edit `.apnea/state.json`. Follow the run's Jujutsu phase-child and `jj squash` workflow, preserving unrelated worktree content. After each approved phase, squash only that phase's reviewed child into its intended phase change before starting the next child.

## Inspected baseline and planning constraints

- The provider and coordinator are separate verified commits. Their retry/bridge, authority, polling, reconciliation, command FIFO, interruption, and tagged-error tests are regression gates, not unfinished acceptance work.
- The current server implementation already contains scoped listener/connection ownership, replay, local failure isolation, blocked-work interruption, late-write suppression, ordered cleanup, and tagged close/unlink handling. The latest abandoned handoff narrows unfinished server work to exactly three evidence/correctness boundaries listed in Phase 1.
- Phase 1 must not recreate the abandoned exhaustive lifecycle matrix or re-review already verified server behavior. Review is limited to its diff and the three stated boundaries; broad suites run only as regression checks.
- The current protocol/client are explicit-path version 1 foundations with Effect schemas plus parallel manual validation. Later phases refine these in place rather than replacing the package boundary.
- Keep daemon, protocol, client, and host-neutral state in `packages/music-core/`. Keep `createSystemMedia()` as a low-level public compatibility API; remove only production host ownership of providers, polling, sampling, clocks, and transport queues.
- The checked-in manifests pin OpenCode/Pi dependencies, while the currently resolved machine binaries differ. Final smokes must execute and assert the exact versions selected in the manifests rather than silently accepting whichever executable is first on `PATH`.
- `docs/music-session-architecture.html` is intentional content. Preserve it until the documentation phase, then edit it in place.

## Phases

### Phase 1 — Close only the three unresolved server boundaries

**Intent**

Amend the accumulated server phase with narrowly targeted production-path evidence and failure-safe tests. Do not add any other server acceptance criterion.

**Files likely touched**

- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

1. A deterministic executable-path cleanup failure exits nonzero and emits diagnostics retaining the `MusicSessionSocketError` tag, failed operation (`close` or `unlink`), and useful message; the remaining cleanup still completes.
2. A real `net.Server` acceptance callback is deterministically delivered after the production `closing` state is set and before listener close completes; that real socket is refused/destroyed and never accepted, enrolled, or finalized as a connection scope.
3. Every existing focused server test is failure-safe: sockets, clients, listeners, Effect scopes, subprocesses, permissions, temporary directories, and Unix paths are released in `finally`/scoped finalizers even when an intermediate assertion fails.

**Verify commands**

```sh
bun test packages/music-core/tests/session-server.test.ts -t 'executable.*cleanup failure|closing.*refus'
bun test packages/music-core/tests/session-server.test.ts
# Baseline regressions only; they are not new Phase 1 acceptance work.
bun test packages/music-core/tests/session-coordinator.test.ts packages/music-core/tests/system-media.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n "Effect\.runSync|setTimeout\(|setInterval\(" packages/music-core/session/coordinator.ts packages/music-core/session/provider.ts packages/music-core/session/server.ts
jj diff --summary
```

**Dependencies**

- Verified provider/coordinator commits and accumulated scoped server implementation.
- Existing `ServerLifecycleHooks`, executable boundary, real Unix sockets, and focused server suite.

**Non-goals**

- Re-proving or changing provider behavior, coordinator authority, replay, normal scoped connection ownership, blocked-work interruption, late-write suppression, ordinary cleanup, existing close/unlink typing, or the complete server lifecycle matrix.
- Protocol changes, discovery/startup, reconnect, idle shutdown, fan-out, artwork, host migration, manifests, or docs.

### Phase 2 — Make the shared wire contract schema-owned and revision-negotiated

**Intent**

Turn the current explicit-path protocol into one additive, Effect-Schema-owned contract with revision-range and capability negotiation, while retaining manually started server/client operation.

**Files likely touched**

- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/tests/session-client.test.ts`

**Acceptance checks**

- Requests, events, responses, nested state, capabilities, revision ranges, and stable errors are decoded from unknown input through Effect `Schema`; parallel hand-written shape validators/casts are removed.
- Hello negotiates protocol major, highest overlapping wire revision, and capability intersection. Package version is diagnostic only.
- Current and immediately preceding supported revisions can share one healthy daemon; disjoint ranges receive one actionable error containing both ranges without disturbing healthy clients.
- Hello-first ordering, increasing request IDs, action/capability checks, seek bounds, malformed/oversized/incomplete frames, and stable response envelopes remain enforced at the boundary.

**Verify commands**

```sh
bun test packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 1 server boundary and existing protocol/framer/client foundations.

**Non-goals**

- Automatic startup, runtime-path discovery, reconnect, idle shutdown, load hardening, artwork, or host changes.

### Phase 3 — Finish the explicit client's truthful request and stream semantics

**Intent**

Make the manually connected lightweight client reliable before adding lifecycle automation.

**Files likely touched**

- `packages/music-core/session/client.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- Responses correlate once; unsolicited/duplicate responses and malformed daemon frames cannot settle the wrong request.
- Wrong-instance, stale, duplicate, and out-of-order snapshots are rejected while valid replay and broadcasts remain ordered.
- Listener exceptions are isolated; disposal is idempotent; every pending request settles once on response, malformed data, disconnect, or disposal.
- A disconnect before a command result is reported as indeterminate and the explicit client never replays that command.

**Verify commands**

```sh
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 2 negotiated schemas.

**Non-goals**

- Reconnect supervision, process launch, default paths, idle exit, load limits, or host presentation.

### Phase 4 — Secure same-user runtime paths and endpoint discovery

**Intent**

Establish safe default machine-local discovery and stale-endpoint classification without spawning a daemon yet.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- A short per-user runtime directory/socket stays within macOS Unix-socket limits and requires owner-only permissions.
- Symlinks, foreign ownership, and unexpected file types are rejected; only an owned, proven-stale socket/marker is removable.
- Probing completes protocol hello before classifying an endpoint healthy, stale, or incompatible.
- A healthy incompatible daemon is never unlinked, killed, or replaced.

**Verify commands**

```sh
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 3 explicit handshake and errors.

**Non-goals**

- Detached spawning, launcher races, reconnect, idle shutdown, or host migration.

### Phase 5 — Add race-safe singleton auto-start and skew policy

**Intent**

Implement `connectOrStart` so concurrent first use produces one daemon/provider owner and version skew cannot cause a replacement storm.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- Concurrent launchers coordinate through an exclusive startup marker while socket bind remains singleton authority; losers exit before provider acquisition.
- The packaged daemon is detached without inherited host stdio/handles, and connection wait uses a bounded jittered Effect `Schedule`.
- Concurrent first use yields one listener, provider object, provider stream, and polling owner.
- Supported clients join the live daemon; incompatibility is terminal for that healthy generation with zero unlink/kill/replacement/retry-loop attempts.

**Verify commands**

```sh
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 4 secure discovery and Phase 2 skew contract.

**Non-goals**

- Reconnect after live loss, idle exit, 24-client load, artwork, or host UI behavior.

### Phase 6 — Supervise reconnect across daemon generations

**Intent**

Recover from genuine endpoint loss without lying about in-flight commands or admitting late data from an old generation.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- Genuine loss starts bounded reconnect supervision and retains the last accepted state for presentation.
- Pending commands settle once as connection-lost/indeterminate and are never replayed.
- Replacement replay under a new daemon instance is adopted; late frames/callbacks/completions from the old socket or daemon are ignored.
- Incompatibility remains non-looping and never triggers replacement.

**Verify commands**

```sh
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 5 singleton startup and Phase 3 truthful request settlement.

**Non-goals**

- Zero-client daemon exit, fan-out pressure, artwork, or host-specific feedback.

### Phase 7 — Add zero-client idle shutdown and lifecycle diagnostics

**Intent**

Complete daemon lifetime semantics separately from concurrency hardening.

**Files likely touched**

- `packages/music-core/session/config.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/tests/session-client.test.ts`

**Acceptance checks**

- Last-client departure starts one configurable idle grace period; a new client cancels it; expiry releases provider/listener and removes owned runtime artifacts.
- Signal, idle, startup-loss, and defect paths finalize resources exactly once.
- Startup, incompatibility, provider degradation, reconnect, client count, and shutdown diagnostics are useful but omit playback/artwork payloads.
- Detached daemon handles do not keep either host process alive.

**Verify commands**

```sh
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 6 reconnect generations.

**Non-goals**

- 24-client backpressure, artwork, host migration, or package smoke.

### Phase 8 — Bound fan-out and prove 24-client operation

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

- Inbound frames, per-client requests, global commands, outbound responses/events, and socket write pressure have explicit bounds.
- Pending state can coalesce per slow client without dropping command responses or required status transitions; abusive/irrecoverably slow clients are disconnected locally.
- Twenty-four alternating OpenCode/Pi identities receive replay and a later update while one provider/stream/poll owner remains active.
- One paused reader cannot delay the other 23; cross-client commands remain globally FIFO and overflow does not kill the worker.

**Verify commands**

```sh
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phases 6–7 complete client and daemon lifetimes.

**Non-goals**

- Host controllers, remote/TCP access, durable history, or artwork rendering.

### Phase 9 — Centralize and bound native artwork reads

**Intent**

Make the daemon the only production owner of native `media-control get --now` artwork reads while leaving catalog lookup and rendering in OpenCode.

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

- A negotiated artwork capability/request validates the full current recording identity before and after the native read and bounds payload size.
- Concurrent identical requests share one scoped Effect cache lookup; settled entries are capacity-bounded and transient failures are not incorrectly retained.
- Unsupported, stale, malformed, failed, disconnected, and disposed requests return stable bounded outcomes without affecting state fan-out.
- No iTunes lookup, download, conversion, color/cell generation, Kitty rendering, or other host presentation moves into core.

**Verify commands**

```sh
bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

**Dependencies**

- Phase 8 bounded client/server protocol and provider authority.

**Non-goals**

- OpenCode cutover, Pi artwork, or UI changes.

### Phase 10 — Introduce a tested OpenCode session-backed adapter

**Intent**

Create the lightweight OpenCode-facing session adapter and deterministic fake seam while leaving the current production selection intact for one green tactical step.

**Files likely touched**

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/artwork-lifecycle.test.ts`

**Acceptance checks**

- A session-client factory/fake can drive replay, live state/status, controls, reconnect generations, disposal, and native artwork responses through existing controller contracts.
- Tests preserve loading semantics, command feedback, local seek coalescing, waveform projection, and late-callback suppression without a real daemon.
- The adapter owns no provider, polling, sampling lane, playback clock, or global transport queue.

**Verify commands**

```sh
bun test --preload @opentui/solid/preload packages/opencode-music-player/tests/system-media.test.ts packages/opencode-music-player/tests/controller.test.ts packages/opencode-music-player/tests/controller-lifecycle.test.ts packages/opencode-music-player/tests/artwork-lifecycle.test.ts
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
jj diff --summary
```

**Dependencies**

- Phase 9 production client/artwork surface.

**Non-goals**

- Switching the production default, deleting the old backend, UI redesign, Pi migration, or packed smoke.

### Phase 11 — Cut OpenCode production over without presentation regressions

**Intent**

Select the session adapter in production and remove OpenCode's duplicate provider authority while preserving the current app/sidebar experience.

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
- Replay/live playing, paused, idle, daemon replacement, disconnect, and incompatibility preserve controls, loading, errors, toasts, waveform, compact bar, and sidebar behavior.
- Native artwork comes through the daemon; identity-aware iTunes fallback, local cache/jobs, image conversion, Kitty/half-block rendering, and completion events remain host-local and bounded.
- Disposal closes only this client, suppresses late state/command/artwork work, and leaves other clients healthy.

**Verify commands**

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
! rg -n "createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision" packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
jj diff --summary
```

**Dependencies**

- Phase 10 tested adapter and Phase 9 artwork capability.

**Non-goals**

- Moving UI/Solid/catalog/rendering into core, changing controls/shortcuts, Pi migration, or final smoke certification.

### Phase 12 — Migrate Pi and prove mixed-host command behavior

**Intent**

Replace Pi's backend/polling/transport ownership with one session client while retaining status-line and waveform behavior.

**Files likely touched**

- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/test/index.test.ts`
- `packages/pi-music-dock/package.json`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

**Acceptance checks**

- A live Pi session owns one client plus local waveform/status work, with no provider probe/retry/poll/sample lane/playback clock/general transport queue.
- `/music`, `/music-next`, `/music-prev`, and shortcuts route through the daemon and preserve per-call notifications.
- Replay/live/replacement/disconnect states preserve status and waveform; reload/shutdown marks the session dead before disposal and ignores late work.
- Pi and OpenCode identities share one daemon FIFO; closing/reloading Pi leaves OpenCode healthy.

**Verify commands**

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,pi-music-dock
! rg -n "createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision" packages/pi-music-dock/extensions/music-dock/index.ts
jj diff --summary
```

**Dependencies**

- Phases 8 and 11 provide bounded mixed-host client behavior.

**Non-goals**

- Pi artwork/seek, footer ownership, command renaming, or final packed smoke.

### Phase 13 — Remove migration scaffolding and finalize package surfaces

**Intent**

Delete obsolete host ownership only after both migrations are green, and finalize exports/manifests without yet making live host smokes the gate.

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

- Obsolete host backend types, provider probes, retries, polling, sampling, playback clocks, and transport queues are gone; `createSystemMedia()` remains an intentional core compatibility export.
- Core exports and `bin`/`files` metadata include every daemon/client runtime file and exclude tests/scripts.
- Host dependency metadata resolves `@naxodev/music-core` correctly and remains exactly version-pinned where host compatibility requires it.
- No generated tarball, socket, marker, log, or build artifact remains in the working copy.

**Verify commands**

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player,pi-music-dock
(cd packages/music-core && npm pack --dry-run --ignore-scripts)
! rg -n "createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision" packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts packages/pi-music-dock/extensions/music-dock/index.ts
jj status
```

**Dependencies**

- Phases 11–12 completed host cutovers.

**Non-goals**

- Publishing, versioning, deleting low-level core compatibility APIs, docs, or host smoke execution.

### Phase 14 — Prove the packed core daemon/client under Node

**Intent**

Upgrade core packing from a file-list check to an isolated installed-package lifecycle smoke.

**Files likely touched**

- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/session/music-sessiond.ts`

**Acceptance checks**

- The verifier builds and packs core, installs the tarball plus dependencies into a temporary project, and resolves no workspace source.
- Installed client code starts/connects to the installed Node executable, completes hello/replay, disconnects, observes status-zero idle exit, and confirms owned socket cleanup.
- Temporary installs, tarballs, runtime artifacts, and child processes are cleaned on success and failure.

**Verify commands**

```sh
bunx nx run music-core:package:check
bunx nx run music-core:smoke
jj status
```

**Dependencies**

- Phase 7 idle exit and Phase 13 finalized package contents.

**Non-goals**

- OpenCode/Pi TUI rendering, publishing, or documentation.

### Phase 15 — Document the completed current architecture

**Intent**

Update prose and the preserved architecture HTML only after behavior and packaging are settled.

**Files likely touched**

- `README.md`
- `packages/music-core/README.md`
- `packages/opencode-music-player/README.md`
- `packages/pi-music-dock/README.md`
- `docs/music-session-architecture.html`

**Acceptance checks**

- Documentation presents 20+ clients → one same-user Unix socket daemon → one provider as current, not future.
- It explains Effect services/Layers/scopes, replay/revisions, compatible and incompatible skew, global FIFO, bounds, reconnect without command replay, indeterminate commands, idle shutdown, native artwork ownership, diagnostics, and O(1) provider/O(N) fan-out costs.
- Host docs distinguish daemon authority from host-local UI/waveform/catalog/rendering work.
- The HTML retains its skip link, labeled navigation/diagrams, source links, responsive/print behavior, reduced-motion support, and visual language.

**Verify commands**

```sh
bunx prettier --check README.md packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md docs/music-session-architecture.html
! rg -n "Direct / current|Broker / scale path|future broker|when coordination is required" docs/music-session-architecture.html packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md
jj diff --summary
```

**Dependencies**

- Phases 2–14 define the architecture being documented.

**Non-goals**

- New behavior, unrelated HTML redesign, publishing, or PR creation.

### Phase 16 — Certify the packed OpenCode plugin against its exact pin

**Intent**

Run the real packed OpenCode presentation smoke against the exact OpenCode version declared by the package, with packed core resolution.

**Files likely touched**

- `packages/opencode-music-player/package.json`
- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/opencode-music-player/scripts/verify-pack.ts`
- `packages/opencode-music-player/tests/package-load.test.ts`

**Acceptance checks**

- The smoke fails clearly on version mismatch and runs the exact pinned `opencode2`, not an unverified `PATH` binary.
- An isolated install resolves packed OpenCode and packed core, loads the real plugin, renders expanded/collapsed/narrow app/sidebar states, and exercises session-backed replay/control presentation.
- Exit leaves no tmux session, daemon/provider handle, tarball, socket, marker, log, or temporary install.

**Verify commands**

```sh
opencode2 --version
bunx nx run opencode-music-player:smoke
jj status
```

**Dependencies**

- Phases 11, 13, and 14.

**Non-goals**

- Updating to an unpinned OpenCode release, redesigning presentation, Pi smoke, publishing, or PR creation.

### Phase 17 — Certify the packed Pi extension against its exact pin

**Intent**

Run the packed extension through the exact Pi version declared by the package and prove prompt process exit.

**Files likely touched**

- `packages/pi-music-dock/package.json`
- `packages/pi-music-dock/scripts/package-smoke.ts`

**Acceptance checks**

- The smoke resolves and asserts the exact pinned Pi executable/version rather than accepting an arbitrary global binary.
- An isolated install resolves packed Pi and packed core, loads the extension in RPC mode, and registers `/music`, `/music-next`, and `/music-prev`.
- The process exits promptly without inherited daemon/provider handles and cleans tarballs/runtime/temp artifacts on success or failure.

**Verify commands**

```sh
pi --version
bunx nx run pi-music-dock:smoke
jj status
```

**Dependencies**

- Phases 12–14.

**Non-goals**

- Pi artwork/seek, accepting a floating host version, publishing, or PR creation.

### Phase 18 — Run the full workspace and mixed-host release gate

**Intent**

Verify the accumulated migration as one system and make only narrow fixes exposed by this gate.

**Files likely touched**

- No product file is expected; if a gate exposes a defect, touch only the existing file that owns that defect and rerun its focused phase checks before this gate.

**Acceptance checks**

- `bun run check` passes, including format, policy, typecheck, unit/integration, parity, package, and smoke targets.
- On macOS with provider tooling, one pinned OpenCode and one pinned Pi instance show the same track; commands from either converge in both; one PID/socket/provider serves them; reload does not duplicate ownership.
- Daemon replacement recovers without command replay; missing tools and restart yield actionable feedback; final disconnect releases daemon/provider and removes owned artifacts after idle grace.
- The worktree contains no generated/runtime artifacts; unrelated changes and `.apnea/state.json` remain untouched.

**Verify commands**

```sh
bun run check
opencode2 --version
pi --version
jj status
```

Manual mixed-host check:

```sh
python3 -m http.server 8000
# Inspect docs/music-session-architecture.html, then run the exact pinned OpenCode and Pi hosts against the same machine-local session on macOS.
```

**Dependencies**

- Phases 1–17.

**Non-goals**

- Feature expansion, publishing, tagging, pushing, opening a PR, or unrelated cleanup.

### Phase 19 — Produce the terminus PR description artifact

**Intent**

When dispatched at terminus, write the PR description to the exact artifact path supplied by that dispatch; do not open or update a PR.

**Files likely touched**

- Only the dispatcher-provided PR-description artifact; no product source.

**Acceptance checks**

- Front matter is `status: done` only.
- The description summarizes delivered phases, user-visible architecture, Effect ownership, protocol/lifecycle guarantees, host migrations, test plan, manual pinned-host evidence, and residual risk.
- It accurately reflects `jj` history/diff and does not claim a push, publication, or opened PR.

**Verify commands**

```sh
jj log -r 'ancestors(@, 20)' --no-graph -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"'
jj diff --summary
jj status
```

**Dependencies**

- Approved Phase 18 results and the terminus dispatch's exact artifact path.

**Non-goals**

- Product edits, commits, pushes, publishing, or opening/updating a PR.

## Whole-run definition of done

- `@naxodev/music-core` ships a Node-compatible, same-user machine-local daemon and lightweight client using Effect v4 services, Layers, scopes, supervised work, schemas, config, schedules, replayable state, bounded queues/streams, caches, and tagged failures.
- The three formerly unresolved server boundaries are proven without reopening the verified server matrix: executable cleanup failure is nonzero and diagnostic, the real production closing-refusal branch is deterministic, and all focused server tests are failure-safe.
- The wire protocol is schema-validated, revision/capability negotiated, additive across the supported skew window, bounded, and truthful about indeterminate commands.
- Concurrent first use produces one provider/listener owner; secure discovery never removes foreign, malformed, or healthy incompatible endpoints.
- Reconnect adopts only the replacement generation and never replays commands; zero-client idle shutdown releases provider/listener and owned runtime artifacts exactly once.
- A real 24-client scenario proves one provider/stream/poll owner, immediate replay, one global FIFO, bounded memory/queues, and slow-reader isolation.
- Native provider artwork reads are daemon-owned, identity-checked, deduplicated, and bounded; catalog lookup and rendering remain OpenCode-local.
- OpenCode and Pi own only lightweight clients and local presentation. Existing controls, feedback, waveform, artwork, reload, and teardown behavior remain green.
- Core, OpenCode, and Pi packed-install smokes resolve no workspace source, use exact pinned host versions, and exit without leaked handles or artifacts.
- The preserved architecture HTML and READMEs describe the completed topology as current and retain accessibility/responsive behavior.
- `bun run check` and the real mixed-host macOS check pass; `jj status` contains no generated/runtime debris; unrelated changes and `.apnea/state.json` are preserved.
- The terminus PR-description artifact is complete, but nothing is committed with Git, pushed, published, or opened as a PR.
