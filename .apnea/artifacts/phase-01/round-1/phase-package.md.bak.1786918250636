---
status: done
---

# Phase 1 package: break only the selected production graph shutdown cycle

## Intent

Repair the one unresolved production lifecycle defect in the current dirty tree: the selected listener-first graph owns provider and coordinator in one manually built scope, then waits for connection children before closing that scope. A real connection blocked on coordinator work can therefore prevent the interruption needed to release itself.

Split listener, coordinator, and provider ownership without disturbing the accumulated singleton/startup implementation. Shutdown must execute one non-cyclic sequence:

1. mark the server closing and stop/refuse acceptance;
2. interrupt and close coordinator-owned work;
3. interrupt/await connection children that depended on that coordinator;
4. finalize provider ownership;
5. close the listener and unlink only its exact bound identity.

Prove this through the same selected graph used by production, with a real Unix socket and blocked coordinator operation. Do not supply a prebuilt externally owned coordinator to make the test green. Existing startup markers, bind reservation, `connectOrStart`, same-process singleton tests, and their assertions are baseline regressions only.

Use repository-pinned Effect v4 `Layer`, `Context`, `Scope`, supervised fibers, and finalizers. Do not add raw timers, detached Promise cleanup, or a second graph implementation.

## Files to touch

Only as required:

- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-server.test.ts`

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

Do not create a new source or test module. Keep graph selection, ownership, and shutdown in `server.ts`; keep the executable as a consumer of that shared graph; keep evidence in the existing server test file.

## Exact implementation steps

### 1. Preserve the dirty baseline before editing

1. Inspect `jj diff` for the three allowed product/test paths and treat the existing listener-first acquisition, crash-safe bind reservation, exact-identity cleanup, startup behavior, and tests as pre-existing baseline.
2. Do not reset, restore, clean, or rewrite the current change. Do not alter `config.ts`, `client.ts`, startup tests, or architecture HTML to simplify this phase.
3. Keep the current public Promise adapter and executable behavior intact: explicit sockets remain foreground/unmanaged, default execution remains managed, and successful bind/hardening remains the gate before provider acquisition.

### 2. Replace the combined coordinator/provider selection seam

In `packages/music-core/session/server.ts`:

1. Remove the `defaultCoordinatorGraph = Layer.provide(coordinatorLayer, providerLayer)` ownership model. The selected graph seam must accept/select a **provider Layer only**; coordinator construction remains fixed inside the server graph.
2. Keep production selection on the existing `providerLayer`. For `startMusicSessionServer`, map the optional legacy provider to `layerFromLegacy(provider)` and pass that provider Layer into the same selector.
3. Change `layerWithHooks` so focused tests may select lifecycle hooks and a provider Layer, but may not inject a precomposed coordinator+provider Layer. This prevents tests from placing coordinator ownership in an outer scope that production does not use.
4. Keep one shared constructor behind exported `layer`, `layerWithHooks`, `startMusicSessionServer`, and the executable. Do not introduce parallel “test” and “production” graph implementations.
5. Update the existing `session-server.test.ts` call sites mechanically: where they currently pass `Layer.provide(coordinatorLayer, fixture.layer)` or `Layer.provide(coordinatorLayer, layerFromLegacy(...))`, pass only the corresponding provider Layer. Remove the now-unused coordinator-layer import if all uses disappear.

### 3. Build provider and coordinator in distinct Effect scopes

In the shared constructor in `packages/music-core/session/server.ts`:

1. Retain listener acquisition first: create/listen/harden/capture the socket, release the short-lived bind reservation, and only then acquire provider or coordinator ownership.
2. Capture the resolved `MusicSessionConfig` service as well as its options so the internally built coordinator receives the same selected config instance.
3. After listener acquisition, create a dedicated provider `Scope`, immediately retain its close effect, build the selected provider Layer in that scope, and extract `SessionProvider` from its `Context`.
4. Create a separate coordinator `Scope`, immediately retain its close effect, and build the fixed `coordinatorLayer` there while providing the already selected `SessionProvider` service and the captured `MusicSessionConfig` service. Extract `MusicSessionCoordinator` from that coordinator context.
5. Do not rebuild or duplicate the provider while satisfying coordinator dependencies. Exactly one provider Layer instance belongs to the provider scope, and the coordinator only receives that service.
6. Keep the listener inactive/refusing during provider/coordinator construction. Set application acceptance active only after both selected scopes build successfully.
7. Ensure partial acquisition is failure-safe. If provider or coordinator construction fails, the outer listener finalizer must close any scope that was created, then close/unlink the listener. `Scope.close` is the sole owner of each scope's resources; do not manually call provider disposal or coordinator internals.
8. Keep scope closing idempotent so acquisition failure, normal finalization, server fault, and the Promise adapter cannot double-finalize ownership.

Use Effect v4 service/context APIs rather than casts. The ownership shape should be equivalent to:

- outer selected server/listener scope;
- provider child scope containing `SessionProvider`;
- coordinator child scope containing `MusicSessionCoordinator` and borrowing the provider service;
- connection fibers owned by the server and borrowing the coordinator service.

The provider service is borrowed by coordinator/connection work but its scope remains open until those dependents have stopped.

### 4. Encode one explicit non-cyclic shutdown order

Refactor the existing listener release/finalizer in `packages/music-core/session/server.ts` so all exits use this order:

1. Set `active = false` and `closing = true` before any asynchronous wait. Invoke the existing closing hook and destroy/refuse enrolled sockets so no new application work can enter. Preserve the production callback branch that destroys a socket delivered after closing.
2. Preserve the existing `awaitClosing` test gate at the closing boundary; it must not transfer ownership or create another shutdown path.
3. Close the coordinator scope **before** calling `FiberSet.clear`/`FiberSet.awaitEmpty` for connections. Closing that scope must interrupt blocked sampling, transport, polling, event consumption, command workers, and settle coordinator jobs.
4. Only after coordinator closure, interrupt and await every connection child. A socket command waiting on coordinator work must now unwind, and no connection callback/write may survive this join.
5. Close the provider scope after dependent coordinator and connection work has stopped. This is where the provider/event source finalizes exactly once.
6. Shut down server fault observation and detach the listener error handler without dropping retained typed failures.
7. Close the Node listener, invoke the listener-finalized observation, unlink only the captured socket identity, and release any partial bind reservation last.
8. Preserve the existing cleanup-outcome contract: close/unlink failures remain `MusicSessionSocketError`, all cleanup attempts run, the primary failure remains observable at the executable/Promise boundary, and additional cleanup failures are retained/logged as before.
9. Do not “fix” the cycle by ignoring `FiberSet.awaitEmpty`, leaking a scope, releasing the provider early, moving coordinator ownership back outside the server, or merely reordering finalizers within the existing combined scope.

If additional order evidence is needed, add only narrow test hooks such as coordinator-scope-finalized/provider-scope-finalized observations to `ServerLifecycleHooks`. Invoke them after their corresponding `Scope.close` completes. They are observation-only and must not alter production control flow.

### 5. Keep both production entry points on the selected topology

In `packages/music-core/session/server.ts` and `packages/music-core/session/music-sessiond.ts`:

1. `startMusicSessionServer` must select config + provider and call the shared listener/provider/coordinator constructor; it must not precompose coordinator/provider externally.
2. `runMusicSessionDaemon` must continue to provide config to the exported production server layer, which internally selects the production provider and fixed coordinator.
3. Keep one top-level `Effect.runPromise` at the executable boundary, the scoped signal wait, status handling, diagnostics, and cleanup-failure reporting unchanged except for type/composition adjustments required by the new graph contract.
4. Preserve listener-first singleton behavior: bind/hardening failure still acquires zero provider/coordinator ownership. Do not change bind reservation semantics in this phase.

### 6. Replace the bypassing blocked-work fixture with selected-topology evidence

In `packages/music-core/tests/session-server.test.ts`:

1. Add or rename one focused test so its name matches `selected.*blocked` or `blocked.*selected`, for example: `selected graph shutdown interrupts blocked coordinator work before draining connections`.
2. Use `makeCoordinatorProviderFixture()` only as the selected **provider Layer** and controls. Pass `fixture.layer` to the shared selected graph seam; never build `coordinatorLayer` in the test's outer scope.
3. Build the graph in a real Effect scope over a real Unix socket. Connect with the real music-session client, negotiate hello, submit a transport command (or trigger sampling) that the fixture deterministically blocks, and wait on the fixture's latch/queue proving coordinator work actually started.
4. Start closure of the real selected graph. Use Effect synchronization primitives for ordering and an Effect timeout only as a deadlock sentinel; do not use `setTimeout`, `setInterval`, `Bun.sleep`, or polling loops.
5. Assert closure completes within the sentinel and proves all relevant ownership:
   - closing was observed before teardown;
   - blocked coordinator work was interrupted and has zero active operations;
   - the coordinator scope completed before the dependent connection drain;
   - the real connection/input processor finalized exactly once;
   - provider event subscription and provider scope finalized exactly once, after dependent work;
   - listener close and exact unlink occurred once and after provider finalization;
   - the client socket is destroyed and the Unix path is absent.
6. For a blocked socket command, assert its Promise settles once as `INDETERMINATE_COMMAND`. Record write attempts at connection finalization, release the fixture gate after shutdown, yield once, and prove no late response/write occurs.
7. Make the test failure-safe with `finally`: dispose the client, release any fixture gate needed to unstick a failed assertion, close the Effect scope idempotently, destroy raw sockets, and remove only the test's temporary socket path/artifacts.
8. Keep existing sampling, blocked-command, direct-Layer, cleanup-diagnostic, and closing-refusal tests as regressions. Update only their graph-selection syntax as required; do not expand them into a lifecycle matrix.

### 7. Keep this phase isolated

1. Do not add subprocess contender acceptance. Separate daemon winner/loser proof is Phase 2.
2. Do not add `TestClock`, 20-client convergence, marker-release, launcher, or incompatibility-race acceptance. Those are Phase 3.
3. Do not modify existing startup/client behavior to make server tests easier.
4. Format only touched files and inspect the exact diff after tests. Product/test changes must remain in the three allowed paths.
5. Keep work in the current reviewed Jujutsu phase child. Do not run `git commit`, `jj commit`, `jj squash`, push, or open a PR. After approval, the orchestrator may use the prescribed `jj squash` workflow for only this reviewed phase.

## Acceptance checks

Phase 1 is complete only when:

- Listener, provider, and coordinator are separately owned in the one graph selected by production, the Promise adapter, and focused tests.
- Successful listener bind/hardening still gates all provider/coordinator acquisition.
- Shutdown marks acceptance closed, interrupts/joins coordinator work, then drains dependent connection children, then finalizes provider ownership, then closes/unlinks the listener without deadlock.
- A deterministic real Unix-socket selected-topology test blocks coordinator work and proves the full order, exact-once finalization, indeterminate blocked command, and no late write/leak.
- No test obtains a green result by externally owning a precomposed coordinator.
- Existing bind reservation, same-process singleton, startup, closing-refusal, cleanup diagnostics, protocol, client, provider, and coordinator tests remain green only as baseline regressions.
- No Phase 2 process-contender or Phase 3 startup-matrix acceptance enters this phase.
- Unrelated worktree changes, verified commits, `.apnea/state.json`, and `docs/music-session-architecture.html` remain untouched.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/session-server.test.ts -t 'selected.*blocked|blocked.*selected'
bun test packages/music-core/tests/session-server.test.ts
# Baseline regression only; it does not enlarge Phase 1 acceptance.
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n 'Effect\.runSync|setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
jj diff --summary
```

Then inspect the exact diff:

```sh
jj diff --git packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/tests/session-server.test.ts
git diff --check
```

Confirm manually from that diff:

- no product/test path outside the three allowed paths changed during this phase;
- `layerWithHooks` accepts provider selection, not an externally precomposed coordinator;
- coordinator and provider have distinct scopes and close effects;
- coordinator close precedes connection join, provider close follows it, and listener release is last;
- startup/client, bind-reservation policy, protocol, hosts, packaging, and docs were not changed;
- `.apnea/state.json` and unrelated dirty paths were not altered.

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Verified provider (`e7103663`), coordinator (`859fc01d`), scoped server (`66bc1f91`), executable (`e70641bc`), negotiated protocol (`f059efc8`), truthful client (`1411d281`), and secure runtime (`ca96d66d`) commits.
- Current dirty listener-first acquisition, bind reservation, exact bound-path cleanup, startup marker/launcher/client work, and baseline tests.
- Existing `makeCoordinatorProviderFixture`, `layerFromLegacy`, real Unix-socket/client helpers, lifecycle hooks, `FiberSet`, and cleanup outcome plumbing.
- Repository-pinned Effect v4 `Layer`, `Context`, `Scope`, `Effect`, `FiberSet`, `Deferred`, `Latch`, `Queue`, and scoped-finalizer APIs.

## Non-goals

- Separate-process daemon contention, winner hello, loser status, or loser socket non-interference evidence.
- Startup retry pacing, `TestClock`, twenty concurrent `connectOrStart` callers, marker release diagnostics, launcher races, or protocol incompatibility races.
- Reconnect, replacement-generation filtering, idle grace/exit, 24-client load, queue/backpressure policy, artwork, caching, OpenCode, Pi, manifests, packed smokes, READMEs, or architecture HTML.
- Provider/coordinator behavioral redesign, protocol/schema changes, new public client APIs, process killing, launchd/service installation, remote sockets, or multi-user support.
- New source/test modules, unrelated cleanup, Git/Jujutsu commits during coding, squashing before approval, pushing, publishing, opening a PR, or editing `.apnea/state.json`.
