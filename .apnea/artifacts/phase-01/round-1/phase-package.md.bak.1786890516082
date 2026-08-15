---
status: done
---

# Phase 1 package: close only the three unresolved server boundaries

## Intent

Amend the accumulated scoped-server work with only these three fixes:

1. deterministically prove that cleanup failure through the executable runtime path sets nonzero process status and retains tagged operation/message diagnostics;
2. deterministically drive a real Node connection through the production `closing` refusal branch;
3. make every focused server test release its resources if setup or an assertion fails.

Do not reopen the abandoned exhaustive lifecycle matrix. Provider, coordinator, replay, ordinary connection scoping, blocked-work interruption, late-write suppression, cleanup ordering/idempotency, and existing socket-error behavior are already verified. Their suites are regression gates only, not Phase 1 acceptance work.

Preserve the existing server implementation, the provider/coordinator commits, unrelated worktree changes, and `docs/music-session-architecture.html`. Use the repository-pinned Effect v4 APIs only.

## Files to touch

Only:

- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-server.test.ts`

A file need not change if the narrow implementation does not require it.

## Files not to touch

- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/config.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-client.test.ts`
- Anything under `packages/opencode-music-player/`
- Anything under `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

If solving one of the three boundaries appears to require a protocol, provider, coordinator, lifecycle-discovery, host, manifest, or documentation change, stop rather than broadening this phase.

## Exact implementation steps

### 1. Preserve the accepted server baseline

Before editing:

1. Inspect `jj diff --summary` and retain every unrelated path.
2. Treat the current `MusicSessionServerService`, `layerWithHooks`, `startMusicSessionServer`, scoped signal wait, connection `FiberSet`, and cleanup-outcome retention as inputs. Refactor only the seams necessary for the three requirements below.
3. Do not add another runtime, detached Promise loop, timer, retry, protocol branch, lifecycle counter matrix, or duplicate server graph.
4. Keep test hooks in `packages/music-core/session/server.ts`; do not export them from `packages/music-core/index.ts` or create another module.

### 2. Make the executable cleanup-failure path deterministically injectable

In `packages/music-core/session/music-sessiond.ts`:

1. Extract the current executable body into a testable in-file runner that is also called by the existing top-level executable guard. Keep production defaults equivalent to today:
   - parse the supplied argv;
   - compose the production config → provider → coordinator → server graph once;
   - run one scoped foreground Effect;
   - wait on the scoped real process signal boundary or server failure;
   - inspect retained cleanup outcomes after scope closure;
   - emit diagnostics and set nonzero process status on failure.
2. Give the runner only narrow dependency injection needed by the focused test: graph construction (or the server graph), signal emitter, diagnostic sink, and process-status sink/default. Do not add a public-package export, CLI flag, or environment variable that enables test failures in installed production use.
3. Keep one top-level `Effect.runPromise` process boundary. The injected runner must execute the same cleanup-outcome inspection and `formatDaemonError` path as the real executable; do not test a copied formatter or a Promise-facade-only approximation.
4. When scoped shutdown retains `MusicSessionSocketError`, set status to `1` and print all of:
   - `MusicSession.SocketError`;
   - the operation in the existing bracketed form, such as `[close]` or `[unlink]`;
   - the original useful message.
5. If foreground execution and cleanup both fail, preserve the foreground failure and report the cleanup diagnostics as well. Never turn retained cleanup failure into success.

In `packages/music-core/tests/session-server.test.ts`:

6. Replace environment/permission-dependent executable cleanup injection with deterministic use of the runner seam. Prefer a real child process launched from the test with an inline script that imports the runner and supplies a graph using the existing fake provider plus `layerWithHooks` cleanup injection. This avoids inventing another fixture path and yields an actual child exit status.
7. Wait for the child to report listener readiness, send a real `SIGTERM`, and inject one cleanup error only after the corresponding real close/unlink operation has run. Do not use `chmod`, timing sleeps, undocumented environment switches, or an unrelated fake main.
8. Assert child exit status `1`, tagged error text, operation text, injected message text, listener closure, and completion of the remaining cleanup. Always kill/await the child and remove its path/temp directory in `finally`.
9. Name the focused test so it matches `executable.*cleanup failure`.

### 3. Exercise the real production closing-refusal branch

In `packages/music-core/session/server.ts`:

1. Replace the current synthetic pattern where a shutdown hook directly calls the acceptance callback with an observation/barrier seam around the real production state transition.
2. Set the same production `closing` flag used by the real Node `connection` callback before signaling the hook.
3. Allow a focused test to hold finalization after `closing = true` but before `net.Server.close()` stops acceptance. Use an Effect-owned gate/barrier; production with no hook must proceed immediately.
4. Add a narrow observation hook for the refusal branch if needed. It may observe the exact `net.Socket`, but it must not make the refusal decision. The production callback must still execute its normal `if (closing) { socket.destroy(); return }` branch.
5. The gate must remain inside the server finalizer and be interruption-safe. It must not become a public runtime setting or alter ordinary production ordering.
6. Preserve shutdown behavior for already enrolled sockets. Do not add another acceptance callback, socket registry, or runtime.

In `packages/music-core/tests/session-server.test.ts`:

7. Start `server.close()`, await a deterministic signal that production has set `closing`, and hold listener close with the new gate.
8. While that real listener is still accepting, create a real `net.createConnection` to its Unix path. Await observation of that exact socket entering the real production callback and then await client-side closure.
9. Assert the socket is destroyed/refused and that accepted, enrolled, and connection-finalized counts remain zero for it.
10. Release the closing gate, await server shutdown, and assert the path is removed.
11. Release the gate in `finally` even if connection or assertions fail, then destroy the client and await the memoized server close. Do not permit a failed assertion to deadlock finalization.
12. Name the focused test so it matches `closing.*refus`.
13. Remove or rewrite the existing test that passes a synthetic `new net.Socket()` directly to the callback; synthetic callback invocation is not evidence for this requirement.

### 4. Make the entire focused server file failure-safe

Audit every test in `packages/music-core/tests/session-server.test.ts`, not just the two new tests:

1. Declare optional resource handles before the outer `try` and acquire resources inside it. A failed `connected(...)`, second client creation, Layer build, or subprocess readiness assertion must still reach cleanup.
2. Release in reverse ownership order in `finally`:
   - unsubscribe/dispose clients;
   - destroy raw sockets;
   - release any closing/test gates;
   - close/await server facades or Effect scopes idempotently;
   - kill and await subprocesses;
   - restore changed permissions if any remain;
   - remove temporary directories and Unix paths.
3. For expected cleanup-failure tests, assert the failure in the body and catch the same memoized failure only in `finally`. Do not rerun cleanup resources.
4. For Effect Layer tests, always close `Scope` in `finally`, including when `Layer.build`, queue/latch waits, or assertions fail.
5. For tests with multiple clients/sockets, assign each handle immediately after acquisition so a later acquisition failure cannot leak earlier handles.
6. For subprocess stream readers, release readers and terminate/await the child even if readiness or diagnostic parsing fails.
7. Use real unique Unix paths already produced by `socketPath(...)`. Do not use wall-clock time for uniqueness.
8. Do not add arbitrary sleeps, repeated `Effect.yieldNow`, or raw test timers. Synchronize with Node events, existing hooks, `Deferred`, `Latch`, `Queue`, or an explicit gate.
9. Cleanup code may suppress the already asserted expected product error, but it must not silently omit resource release. Keep assertions about product cleanup in the test body.

This audit is mechanical resource safety. Do not add new behavioral scenarios while touching the tests.

### 5. Keep the phase diff narrow and reviewable

1. Format only touched files.
2. Run the two focused tests first, then the complete server file.
3. Run provider/coordinator suites and package targets only as baseline regressions.
4. Inspect `jj diff --summary` and the exact diff. Revert no unrelated path and do not edit `.apnea/state.json`.
5. Keep work in the current Jujutsu phase child for review. Do not run `git commit`, push, or `jj squash` during this coding round. After approval, the run may use its prescribed `jj squash` step to fold only this reviewed phase into the intended server change.

## Acceptance checks

Only these checks decide Phase 1 acceptance:

1. **Executable boundary:** deterministic cleanup failure through the executable runner produces actual nonzero child/process status and diagnostics containing the tagged error, failed operation, and useful original message; other cleanup completes.
2. **Closing refusal:** a real connection accepted by the real Node listener after production sets `closing` is synchronously refused/destroyed by the real production callback and is never accepted, enrolled, or finalized as a connection scope.
3. **Failure-safe focused tests:** every server test cleans all resources if setup or any assertion fails, including sockets, clients, listener/server, scopes, subprocesses, gates, temporary directories, permissions, and Unix paths.

Passing replay, scoped connection, blocked sample/command, late write, normal cleanup, close/unlink typing, provider, and coordinator tests is required only to show no regression. Those behaviors are not new acceptance work and must not be re-audited unless this phase's diff changes them or a regression command fails.

## Verify commands

Run from the repository root in this order:

```sh
bun test packages/music-core/tests/session-server.test.ts -t 'executable.*cleanup failure|closing.*refus'
bun test packages/music-core/tests/session-server.test.ts
# Baseline regressions only; do not turn them into new Phase 1 findings.
bun test packages/music-core/tests/session-coordinator.test.ts packages/music-core/tests/system-media.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n "Effect\.runSync|setTimeout\(|setInterval\(" packages/music-core/session/coordinator.ts packages/music-core/session/provider.ts packages/music-core/session/server.ts
jj diff --summary
```

Expected focused evidence:

- both regex-selected tests execute and pass;
- the full server suite exits without leaked handles or retained paths;
- diagnostics assertions include `_tag`/tag text, operation, and message rather than only checking a generic nonzero exit;
- no focused test relies on `chmod`, arbitrary sleep, or synthetic invocation of the acceptance callback for the two new boundaries.

## Dependencies

- Verified provider commit `e7103663` and coordinator commit `859fc01d`.
- Accumulated scoped server implementation in `66bc1f91`.
- Existing `MusicSessionSocketError`, `MusicSessionServerService` cleanup outcomes, `layerWithHooks`, fake provider, scoped signal wait, and real Unix-socket test helpers.
- macOS/Node Unix-domain sockets, Bun test runner, and repository-pinned Effect v4.

## Non-goals

- Reworking or adding acceptance evidence for provider attempts, bridge bounds, retry schedules, coordinator authority, polling/reconciliation, command FIFO, replay, ordinary connection ownership, blocked work, late writes, normal cleanup ordering/idempotency, or existing listen/close/unlink semantics.
- Schema/protocol revisions, capability negotiation, client request semantics, runtime-directory security, stale endpoint recovery, singleton startup, reconnect, idle shutdown, lifecycle diagnostics expansion, 24-client fan-out, slow readers, or backpressure.
- Artwork, OpenCode migration, Pi migration, host UI behavior, manifests, packing, pinned host smokes, READMEs, or architecture HTML.
- New source/test modules or public exports.
- Publishing, committing, squashing before approval, pushing, opening a PR, editing `.apnea/state.json`, or cleaning/resetting unrelated worktree changes.
