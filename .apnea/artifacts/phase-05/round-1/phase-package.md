---
status: done
---

# Phase 5 package: zero-client idle shutdown and lifecycle diagnostics

## Intent

Complete daemon lifetime semantics independently of fan-out hardening.

The selected daemon must keep exactly one configurable Effect-owned idle grace while it has zero negotiated clients. A successfully negotiated client cancels that grace; only the departure of the last negotiated client starts a new grace. Expiry ends the daemon foreground so the existing Phase 1 graph finalizer closes coordinator work, drains connections, finalizes provider ownership, closes/unlinks the listener, and removes only owned runtime artifacts.

This phase also proves startup-with-no-client cleanup, reconnect interaction, signal/defect/idle convergence, exact-once finalization, and bounded lifecycle diagnostics. It does not add Phase 6 queue bounds or 24-client load.

Use repository-pinned Effect v4 `Config`, `Clock`/`Effect.sleep`, scopes, supervised fibers, queues/`Deferred`, and synchronization primitives. Do not use raw timers, detached Promise timers, or callback-owned daemon lifetime.

## Files to touch

Only as required:

- `packages/music-core/session/config.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/tests/session-client.test.ts`

Prefer no public protocol or index change. Idle expiry is a local daemon lifecycle event, not a wire message.

## Files not to touch

- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- `packages/music-core/tests/system-media.test.ts`
- Anything under `packages/opencode-music-player/` or `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

Do not create a new source or test module. Keep idle policy in the existing config/server/executable ownership boundaries.

## Exact implementation steps

### 1. Preserve approved startup and reconnect behavior

1. Inspect the current tree and retain approved Phase 1–4 changes, including selected shutdown ordering, process singleton evidence, Phase 3 startup/marker policy, and the scoped reconnecting client.
2. Do not change bind reservation, socket identity, protocol negotiation, command settlement, generation fencing, or incompatibility policy to implement idle shutdown.
3. Existing signal, server-fault, explicit close, and reconnect tests are baseline. Add only idle-specific acceptance.

### 2. Add one validated idle-grace setting

In `packages/music-core/session/config.ts`:

1. Add `idleGraceMs` to `MusicSessionOptions`, defaults, and `ResolvedMusicSessionOptions`.
2. Choose a finite positive production default long enough for a newly launched client to complete hello, while tests pass explicit short/virtual values.
3. Resolve it through the existing tagged `MusicSessionConfigError` boundary using the same positive-safe-integer validation as other timings. Reject zero, negative, non-integer, non-finite, and unsafe values.
4. If the existing environment-backed Layer exposes all runtime timings, add a matching `Config` entry there; do not read `process.env` in server/executable workflow logic.
5. Keep `pollMs.idle` distinct: provider polling cadence and zero-client daemon grace are separate settings.

Add focused config assertions for valid override/default and tagged invalid values. Do not expand general config coverage.

### 3. Count only negotiated application clients

In `packages/music-core/session/server.ts`:

1. Do not use raw Node acceptance as client presence. A socket counts only after a valid compatible hello has been processed and the connection is enrolled as an active application client.
2. Extend the existing `connection(...)` ownership contract with narrow internal join/leave Effects or callbacks:
   - call join exactly once after successful negotiation and before normal post-hello work is exposed;
   - call leave exactly once from that connection scope's finalizer only if join occurred.
3. Pre-hello sockets, malformed clients, incompatible hello attempts, refused closing sockets, and enrollment failures never increment the negotiated-client count and therefore cannot pin the daemon alive.
4. Preserve existing accepted/enrolled/connection-finalized hooks and semantics. Add observation-only hooks such as `onClientCount`, `onIdleStarted`, `onIdleCanceled`, and `onIdleExpired` only if needed for deterministic tests.
5. Isolate hook exceptions so they cannot affect count/timer ownership.

### 4. Own idle timing in one server-scoped supervisor

In `packages/music-core/session/server.ts`:

1. Add one server-scoped idle supervisor, not one timer per socket. It must be acquired after the listener/provider/coordinator graph is ready and finalized with the server scope.
2. Use an Effect queue/state machine or equivalent serialized Effect synchronization for join/leave events. Keep these invariants:
   - client count is never negative;
   - at most one grace sleep is live;
   - join while count is zero cancels the current grace before publishing the new count;
   - leave starts a grace only on the transition from one to zero;
   - non-last departures do not start or replace a grace;
   - stale/canceled sleepers cannot expire a newer zero-client generation.
3. Start an initial grace when the selected listener becomes active with zero clients. This cleans a daemon whose launcher disappears before any hello.
4. Drive time with `Effect.sleep`/Effect `Clock`. Fork the supervisor in the server scope (`forkScoped`, server-owned `FiberSet`, or equivalent); never attach a post-departure sleeper to the departing connection scope.
5. On grace expiry, complete one server-owned `Deferred` with an idle reason. Do not directly close provider/listener from the timer fiber.
6. Make expiry exact-once. Once idle authority wins, later join/leave events cannot restart the server or emit duplicate shutdown.
7. Shut down the idle event queue/supervisor during every graph exit without converting normal interruption into a server defect.

Expose through `MusicSessionServerService` one scoped foreground effect equivalent to `awaitShutdown`/`awaitIdle`, carrying an idle reason if useful. Keep it internal to daemon/server ownership.

### 5. Route idle expiry through the existing selected shutdown

1. In `runMusicSessionDaemon`, race the scoped signal fiber, `server.awaitFailure`, and the idle-expiry effect.
2. If signal wins, preserve current clean status and diagnostics.
3. If idle wins, let the daemon program return normally so outer `Effect.scoped` executes the unchanged Phase 1 finalizer. Do not duplicate cleanup in the daemon runner.
4. If server failure wins, preserve the existing tagged nonzero behavior and cleanup-failure reporting.
5. Update `startMusicSessionServer`'s compatibility lifetime similarly: race explicit `close()`, server failure, and idle expiry. A later `close()` after automatic idle exit must be idempotent and observe the completed lifetime rather than starting cleanup again.
6. Preserve the Phase 1 shutdown sequence on idle: stop acceptance → close coordinator → drain dependent connections → close provider → close/unlink listener.
7. Keep explicit `--socket` and managed default behavior identical except that both now obey the configured idle grace.

### 6. Add bounded lifecycle diagnostics

1. Emit or expose diagnostics for negotiated client-count transitions, grace start/cancel/expiry, and shutdown reason.
2. Keep diagnostics bounded and structural: daemon instance ID, count, operation/reason, and tagged errors only.
3. Never log playback state, track metadata, artwork bytes, marker tokens, complete environment values, or command payloads.
4. Preserve current startup/listening, provider degradation, reconnect, incompatibility, and cleanup diagnostics. Do not redesign logging infrastructure in this phase.
5. Tests should use observation hooks or captured daemon diagnostics rather than parsing incidental Effect log formatting.

### 7. Prove grace start, cancellation, and restart with TestClock

In `packages/music-core/tests/session-server.test.ts`:

1. Build the real selected server Layer in an Effect test scope with an explicit `idleGraceMs` and `TestClock`; do not test a duplicate timer helper.
2. Prove the initial zero-client grace starts once.
3. Advance virtual time to just before expiry and prove the graph remains live and connectable.
4. Complete a real compatible hello before expiry and prove the grace is canceled and no idle event occurs after advancing beyond the old deadline.
5. Connect a second negotiated client. Close only one and prove count remains one with no grace.
6. Close the last client and prove exactly one fresh grace starts.
7. Reconnect before that deadline, advance beyond it, and prove cancellation again.
8. Close the last client once more, advance the full grace, and prove exactly one idle expiry.
9. Use real Unix sockets/client hello and unconditional scope/client cleanup. Do not use `setTimeout`, `setInterval`, `Bun.sleep`, or polling.

### 8. Prove non-clients cannot pin the daemon

Add focused real-socket cases, preferably in the same server test:

1. Hold a raw pre-hello socket open; advance the initial grace and prove idle shutdown destroys it.
2. Send malformed or incompatible hello and prove it never increments count or cancels grace.
3. A socket delivered after closing remains refused under existing Phase 1 behavior.
4. Ensure every raw socket, frame reader, scope, and gate is retained immediately and released in `finally` even when setup assertions fail.

Do not turn this into a protocol validation matrix; existing protocol tests remain baseline.

### 9. Prove idle cleanup uses the selected graph exactly once

1. Start a real selected server with an instrumented fake provider and lifecycle hooks.
2. Complete one hello, disconnect it, and let idle expire.
3. Assert exact-once outcomes:
   - coordinator scope finalized;
   - all connection/input/forwarder fibers finalized;
   - provider event subscription and provider scope finalized;
   - listener closed;
   - exact bound socket unlinked;
   - bind reservation and temporary reservation names absent.
4. Assert ordering remains coordinator → connections → provider → listener/unlink. Do not add an idle-specific alternative finalizer.
5. Repeat only the narrow signal-vs-idle race needed to prove one winner and one finalization; existing signal/defect cleanup tests remain regressions.
6. If signal, idle expiry, and a server defect become ready concurrently, exactly one foreground result controls status while all resources finalize once. A genuine defect must not be silently converted to successful idle exit.

### 10. Prove executable startup-loss and idle exit

In `packages/music-core/tests/session-server.test.ts`:

1. Use the existing child-process `runMusicSessionDaemon` pattern with a fake selected provider and a short explicit idle grace.
2. Start the real executable runner with no clients and no signal. Require listening first, then prompt status-zero process exit caused by idle expiry.
3. Assert diagnostics identify idle shutdown without playback payloads.
4. Assert socket, bind lock, temporary reservation names, provider ownership, signal listeners, child process, streams, and temporary directory are cleaned on success and failure.
5. Bound child exit/collector waits with an Effect timeout that throws into `try`/`finally`; Bun's outer test timeout is not cleanup.
6. Do not add packed-install or Node package smoke here; Phase 12 owns that evidence.

### 11. Prove reconnect interaction without broadening reconnect scope

In `packages/music-core/tests/session-client.test.ts`:

1. Use the approved reconnecting client and its existing connector/launcher seam with two real selected server generations.
2. Arrange generation A's last negotiated connection to disappear, allow A's idle grace to expire, and gate replacement startup until A's socket is gone.
3. Require the managed client to start/adopt generation B with a different daemon instance ID through the existing Phase 3 startup workflow.
4. Assert retained state during the gap, no replay of commands, one A finalization, and one B provider/listener owner.
5. In a separate cancellation case, reconnect before A's grace expires and prove it joins the same A generation, cancels idle, and does not launch B.
6. Healthy incompatibility remains terminal and must not cancel/replace that healthy generation; reuse Phase 4/3 assertions rather than adding a skew matrix.
7. Dispose managed clients and close any remaining server in `finally`; no reconnect fiber or late server may outlive the test.

### 12. Keep this phase isolated

1. Do not add queue capacities, outbound coalescing, slow-reader eviction, or 24-client load.
2. Do not add artwork/caching or host behavior.
3. Do not change public reconnect semantics except the minimum needed to observe real idle replacement; prefer no client API change.
4. Format only touched files and inspect the exact diff.
5. Keep work in the current reviewed Jujutsu phase child. Do not run `git commit`, `jj commit`, `jj squash`, push, or open a PR. After approval, the orchestrator may squash only this reviewed phase through the prescribed workflow.

## Acceptance checks

Phase 5 is complete only when:

- `idleGraceMs` is finite, positive, config-owned, and distinct from provider idle polling.
- Exactly one server-scoped Effect idle supervisor tracks negotiated clients; raw/pre-hello/incompatible sockets cannot pin the daemon.
- Initial zero-client startup and last-client departure each start one grace; a negotiated client cancels it; non-last departures do not restart it.
- TestClock proves no early expiry, cancellation, restart, and exact-once expiry through the real selected Layer.
- Idle expiry ends the daemon foreground and uses the Phase 1 shutdown order with exact-once coordinator/connection/provider/listener finalization and exact-identity artifact cleanup.
- Signal, idle, explicit close, startup-loss, and defect paths converge without duplicate finalization or masking a genuine defect.
- The executable exits status zero after no-client idle grace and leaks no signal/process/socket/reservation/provider handle.
- The reconnecting client can cancel grace by rejoining A or adopt B after genuine A idle exit, while retaining state and never replaying commands.
- Lifecycle diagnostics are useful and bounded and contain no playback/artwork payload.
- Phase 1–4 suites remain green as baseline only; no Phase 6 fan-out or later acceptance enters this phase.
- Unrelated dirty content, verified commits, `.apnea/state.json`, and `docs/music-session-architecture.html` remain untouched.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t 'idle|last client|grace'
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
# Baseline regression only; it does not enlarge Phase 5 acceptance.
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/session/client.ts
jj diff --summary
```

Inspect the exact phase diff:

```sh
jj diff --git packages/music-core/session/config.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/session/client.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
git diff --check
```

Confirm manually:

- client presence begins only after compatible hello and leaves exactly once;
- one server-scoped supervisor owns all grace timing;
- idle expiry signals the foreground and does not directly duplicate cleanup;
- daemon/Promise boundaries race idle with signal/close/fault truthfully;
- Phase 1 finalization order remains the sole cleanup path;
- diagnostics contain lifecycle metadata only;
- reconnect tests do not add a second reconnect/startup implementation;
- no fan-out, backpressure, artwork, host, packaging, or docs work entered the phase;
- `.apnea/state.json` and unrelated dirty paths were not altered.

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Approved Phase 1 (`08acaab5`), Phase 2 (`73a988d6`), Phase 3 (`788473b7`), and Phase 4 (`b376a94d`) changes.
- Existing selected server service, Phase 1 shutdown order/hooks, `runMusicSessionDaemon`, real Unix helpers, fake provider counters, and reconnecting client generation controls.
- Repository-pinned Effect v4 `Config`, `Clock`/`TestClock`, `Effect.sleep`, scopes, supervised fibers, queues, `Deferred`, `Ref`, and synchronization APIs.

## Non-goals

- Per-client/global queue bounds, outbound state coalescing, socket write backpressure, slow-reader eviction, or 24-client fan-out.
- Artwork protocol/cache, OpenCode or Pi migration, manifests, packed smokes, READMEs, or architecture HTML.
- Protocol negotiation/capability changes, command replay, durable history, remote sockets, process replacement/killing, launchd/service installation, or multi-user sharing.
- New source/test modules, unrelated cleanup, commits or squashing during coding, pushing, publishing, opening a PR, or editing `.apnea/state.json`.
