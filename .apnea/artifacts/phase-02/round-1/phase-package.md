---
status: done
---

# Phase 2 package: prove process-level two-daemon singleton non-interference

## Intent

Prove, and only prove, that two separate daemon processes racing the same explicit Unix socket produce one healthy listener/provider/coordinator winner and one tagged nonzero loser that cannot disturb the winner.

This phase exercises socket bind as final singleton authority below startup-marker coordination. Both contenders must run the real `runMusicSessionDaemon` process boundary and the Phase 1 selected graph. Use an explicit `--socket` path so neither contender uses `connectOrStart` or a startup marker. The winner must complete a real client hello after the loser exits; the loser must acquire zero provider Layer, event subscription, coordinator, polling, or command ownership.

Treat Phase 1 selected shutdown/readiness, the current same-process bind race, and all accumulated singleton/startup behavior as baseline. Do not add Phase 3 `TestClock`, 20-client convergence, marker-release, launcher, or incompatibility acceptance.

## Files to touch

Prefer a test-only change:

- `packages/music-core/tests/session-server.test.ts`

Only if the separate-process proof exposes a real boundary defect, narrowly correct its existing owner in:

- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`

Do not add a new source or test module.

## Files not to touch

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- `packages/music-core/tests/system-media.test.ts`
- Anything under `packages/opencode-music-player/` or `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

Do not change bind policy merely to make the test deterministic. The current crash-safe reservation and socket identity must be exercised as production code.

## Exact implementation steps

### 1. Preserve the approved Phase 1 baseline

1. Start from approved change `08acaab5` and inspect the current diff before editing.
2. Retain the Phase 1 provider-only selected graph, deterministic event-subscription readiness, and coordinator → connections → provider → listener shutdown order.
3. Retain the existing bind reservation implementation: exclusive publication, proven-dead recovery, exact-identity cleanup, and release after successful socket hardening.
4. Do not reset or rewrite accumulated startup changes in `config.ts`, `client.ts`, or their tests.

### 2. Add an in-test separate-process contender harness

In `packages/music-core/tests/session-server.test.ts`:

1. Add local helper code in this existing test file to spawn one contender with `Bun.spawn`; do not create a fixture file.
2. Run each child with `process.execPath`, `--eval`, and absolute module URLs for the existing `music-sessiond.ts`, `config.ts`, `provider.ts`, and `server.ts` modules, following the established executable subprocess test pattern in this file.
3. Give both children the same absolute explicit socket argument through `--socket`. Explicit mode intentionally bypasses managed runtime discovery and startup-marker coordination.
4. In each child, compose exactly the shared selected graph:
   - `layerWithHooks(...)` from `server.ts`;
   - `layerFromLegacy(createFakeProvider())` as the selected provider Layer;
   - the existing config Layer for options supplied by `runMusicSessionDaemon`.
   Do not precompose or externally own `coordinatorLayer`.
5. Use the existing `runMusicSessionDaemon` runner. Do not duplicate its signal wait, error formatting, status handling, or graph lifetime in the child script.
6. Give each contender a distinct ID and emit bounded newline-delimited JSON observations on stderr. Record only lifecycle metadata, never playback state. At minimum record:
   - child ready at the parent-controlled race barrier;
   - daemon diagnostics, including listening or tagged listen failure;
   - `onCoordinator` acquisition count;
   - exit status selected by `setStatus`;
   - final fake-provider counts (`subscriptions`, event disposals, provider disposals, samples) after the runner returns.
7. Keep the child's provider object private. The observable ownership proof is provider Layer finalization/subscription plus coordinator acquisition, not object construction in test setup.
8. Pipe stdin and stderr, ignore stdout, use no shell, and retain each child handle immediately so `finally` can terminate it even if setup or parsing fails.

### 3. Synchronize a real bind race without startup behavior

1. Have each child announce barrier readiness before invoking the daemon runner, then wait for one byte/line or stdin closure from the parent.
2. Start both stderr collectors immediately and wait until both children report barrier readiness.
3. Release both stdin barriers back-to-back. Do not stagger them based on socket appearance and do not invoke `connectOrStart`.
4. Use process/event promises or Effect synchronization to observe outcomes. Do not use `setTimeout`, `setInterval`, `Bun.sleep`, filesystem polling, or an ad hoc retry loop. The Bun test timeout or an Effect timeout may serve only as a deadlock sentinel.
5. Require exactly one listening observation and exactly one contender failure. A test where one daemon is deliberately started after the other is not sufficient.

### 4. Prove winner and loser ownership

For the loser:

1. Await prompt process exit with status `1`.
2. Assert diagnostics retain `MusicSession.SocketError`, operation `[listen]`, the contested path/useful message, and no misleading successful-listening diagnostic.
3. Assert `onCoordinator` was never observed.
4. Assert final provider counts are all zero for ownership-sensitive fields: no event subscription, event-source disposal, provider disposal, sample/poll activity, or command work.
5. Assert it never emits a normal stopped-success outcome.

For the winner:

1. Assert one listening diagnostic and one coordinator acquisition.
2. As soon as listening is observed, capture the real socket's `lstat` identity (`dev`, `ino`, `uid`) and exact `0600` mode.
3. Create and retain a real `createMusicSessionClient` against that path. Require negotiated hello, nonempty daemon instance ID, replay/status, and a healthy selected revision.
4. Await the loser's exit while the first supported client remains connected.
5. Re-stat the socket and assert the same device/inode/owner and `0600` mode. The path must still be a Unix socket.
6. Create a second real client after loser exit and require completed hello against the same daemon instance ID. This proves loser cleanup did not unlink, replace, chmod, close, or otherwise poison the winner.
7. Dispose only the test clients, send `SIGTERM` to the winner, and assert normal status `0`/no nonzero status callback.
8. Assert winner final counts show exactly one provider ownership lifecycle: one event subscription, one event-source disposal, and one provider disposal. Coordinator acquisition is exactly one.
9. After winner exit, assert the explicit socket and `${socketPath}.bind-lock` are absent and no temporary bind-reservation name remains in the test directory.

Do not send a signal to the loser as part of its expected path. It must terminate from its own tagged bind failure.

### 5. Make every failure path cleanup-safe

1. Create one real temporary directory for the test and place the short explicit socket path inside it.
2. Retain child handles, stdin writers, stderr readers/collectors, clients, and captured paths immediately after acquisition; do not hide them in an all-or-nothing `Promise.all` assignment.
3. In `finally`:
   - dispose both clients if created;
   - close/cancel stdin and stderr resources;
   - send `SIGKILL` only to children still alive because the test failed;
   - await both child exit promises without double-wait races;
   - remove the temporary directory recursively.
4. Cleanup must not depend on the winner/loser assertions being correct. If both children hang, both lose, or both claim listening, `finally` must still complete.
5. Keep child diagnostics bounded and include them in assertion failures for debuggability.

### 6. Correct production only if the process proof exposes a defect

If the new test fails because production violates the specified policy, make the smallest correction in `server.ts` or `music-sessiond.ts`:

1. Preserve socket bind/hardening before provider acquisition.
2. Preserve exact-identity ownership: a contender may remove only its own reservation/partial bound path and must never unlink/chmod/close a peer's socket.
3. Preserve the Phase 1 selected graph and shutdown order.
4. Preserve the executable's tagged formatting and nonzero status on bind failure.
5. Do not add process killing, replacement, startup-marker logic, retries, sleeps, or environment switches.

A test-only observability hook may be added to the existing `ServerLifecycleHooks` only if current provider/coordinator counts cannot establish ownership. It must be synchronous, test-only, and incapable of changing production control flow.

### 7. Keep Phase 2 isolated

1. Do not add or change `connectOrStart` behavior.
2. Do not add startup-marker acquisition/release assertions.
3. Do not add `TestClock`, schedule pacing/capping, 20-client convergence, launcher-option, spawn-failure, or incompatibility-race tests.
4. Do not add reconnect, idle shutdown, fan-out bounds, artwork, host migration, packaging, or docs.
5. Format only touched files and inspect the exact diff.
6. Keep work in the current reviewed Jujutsu phase child. Do not run `git commit`, `jj commit`, `jj squash`, push, or open a PR. After approval, the orchestrator may squash only this reviewed phase through the prescribed workflow.

## Acceptance checks

Phase 2 is complete only when:

- Two separately spawned daemon processes cross a parent-controlled barrier and contend concurrently for one explicit real Unix socket.
- Exactly one process listens, acquires one provider/event/coordinator owner, and completes real hello/replay.
- Exactly one process exits promptly with status `1` and actionable tagged `[listen]` diagnostics.
- The loser records zero provider subscription/finalization, coordinator, sample/poll, and command ownership.
- The socket's exact identity and `0600` mode survive loser exit; an existing winner client remains healthy and a second client completes hello against the same daemon instance.
- The winner exits cleanly on `SIGTERM`, finalizes its one provider lifecycle, and removes its socket/reservation artifacts.
- Every child, stream, client, and temporary artifact is released on success and assertion failure.
- Existing same-process singleton and Phase 1 shutdown/readiness tests remain green only as baseline regressions.
- No Phase 3 startup acceptance enters this phase.
- Unrelated worktree content, verified commits, `.apnea/state.json`, and `docs/music-session-architecture.html` remain untouched.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/session-server.test.ts -t 'process.*daemon.*contender|daemon.*winner.*loser'
bun test packages/music-core/tests/session-server.test.ts
# Baseline regression only; it does not enlarge Phase 2 acceptance.
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

Inspect the exact phase diff:

```sh
jj diff --git packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/tests/session-server.test.ts
git diff --check
```

Confirm manually:

- the new proof uses two real child processes and one explicit real socket;
- neither child invokes discovery, startup markers, the managed launcher, or `connectOrStart`;
- loser ownership counts are zero and winner ownership counts are exactly one;
- winner socket identity/mode and post-loser hello are asserted;
- process/resource cleanup is unconditional;
- any product correction is limited to the existing server/executable singleton boundary;
- no client/config/startup, protocol, provider/coordinator behavior, host, package, or documentation path changed;
- `.apnea/state.json` and unrelated dirty paths were not altered.

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Approved Phase 1 change `08acaab5`, including provider-only selected graph, deterministic event-source readiness, distinct provider/coordinator scopes, and ordered shutdown.
- Current crash-safe bind reservation, exact socket identity/hardening, tagged `MusicSessionSocketError`, and executable `runMusicSessionDaemon` seam.
- Existing `Bun.spawn` executable test pattern, `readUntil`/framing helpers, `createMusicSessionClient`, `createFakeProvider`, `layerFromLegacy`, and real Unix-socket support.
- Repository-pinned Effect v4 and Bun child-process APIs.

## Non-goals

- Managed startup markers, `connectOrStart`, detached launcher behavior, `TestClock`, schedule pacing, twenty-client convergence, marker release diagnostics, or incompatibility races.
- Reconnect, replacement generations, idle exit, 24-client load, backpressure, artwork, OpenCode, Pi, package smokes, READMEs, or architecture HTML.
- Reopening Phase 1 graph readiness/shutdown except to fix a regression directly exposed by the process test.
- New provider/coordinator semantics, protocol/schema changes, process replacement/killing policy, launchd/service installation, remote sockets, multi-user sharing, or durable history.
- New source/test modules, unrelated cleanup, commits or squashing during coding, pushing, publishing, opening a PR, or editing `.apnea/state.json`.
