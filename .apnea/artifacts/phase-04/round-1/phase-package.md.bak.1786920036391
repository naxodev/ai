---
status: done
---

# Phase 4 package: supervise reconnect across daemon generations

## Intent

Add one lightweight managed/reconnecting client on top of the verified explicit client and Phase 3 `connectOrStart` workflow.

After a genuine retryable socket loss, the managed client must retain the last accepted provider status/state for presentation, settle every in-flight command once as indeterminate, and supervise bounded startup of a replacement daemon generation. It must adopt only a completed replacement hello/replay, ignore every late callback from the old generation, and never replay a command. Healthy protocol incompatibility is terminal and must not cause replacement loops.

Keep the explicit client and `connectOrStart` single-generation semantics intact. Zero-client daemon exit belongs to Phase 5; fan-out, artwork, and host migration remain later phases.

Use repository-pinned Effect v4 scopes, supervised fibers, `Deferred`/`Ref`, and the already bounded Phase 3 startup schedule. Do not create raw timer loops, detached Promise supervisors, or a second discovery/startup algorithm.

## Files to touch

Only as required:

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

Prefer keeping connection-lifecycle types in `client.ts`; touch `protocol.ts` only if a stable shared schema/type is genuinely required. Keep focused reconnect evidence primarily in `session-client.test.ts`.

## Files not to touch

- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/tests/session-protocol.test.ts` unless `protocol.ts` must change
- `packages/music-core/tests/session-coordinator.test.ts`
- `packages/music-core/tests/system-media.test.ts`
- Anything under `packages/opencode-music-player/` or `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

Do not create a new source or test module. Keep explicit, startup, and reconnect ownership together in the existing client module.

## Exact implementation steps

### 1. Preserve the approved baseline

1. Inspect the current tree and retain approved Phase 1 (`08acaab5`), Phase 2 (`73a988d6`), and Phase 3 (`788473b7`) behavior unchanged.
2. Preserve the explicit client's verified handshake/frame/request semantics, Phase 3 marker finalization, startup pacing, 20-client convergence, incompatibility policy, and single-generation `connectOrStart` API.
3. Do not move server lifetime, provider ownership, polling, or command serialization into the reconnect client.

### 2. Expose one exact terminal observation from the explicit client

In `packages/music-core/session/client.ts`:

1. Add a narrow internal or public terminal-observation mechanism that reports the explicit client's terminal `MusicSessionClientError` exactly once.
2. It must distinguish:
   - retryable transport loss (`CONNECTION_LOST`) that may authorize managed reconnect;
   - non-retryable malformed/incompatible/protocol terminal errors;
   - caller disposal, which never authorizes reconnect.
3. A subscriber attached after terminal transition must observe the retained terminal outcome immediately, so the managed wrapper cannot miss a close between hello completion and listener registration.
4. Terminal observers must be isolated from one another; an observer exception cannot alter settlement or socket ownership.
5. `dispose()` remains idempotent and cannot overwrite an earlier terminal outcome, redestroy a socket, or emit a reconnectable loss.
6. Preserve existing request behavior: every admitted pending command on transport loss rejects once as `INDETERMINATE_COMMAND`; commands are never retained for retry by the explicit client.

Do not add reconnect logic to the explicit `Client` class itself. It remains one socket/one generation.

### 3. Define a separate managed client contract

In `packages/music-core/session/client.ts`, add a distinct reconnecting client type rather than silently changing `MusicSessionClient` semantics.

The contract must provide:

1. Current generation metadata as getters: daemon instance ID, negotiated capabilities, and selected revision when connected.
2. Last accepted `ProviderStatus` and `RevisionedState`. These remain available while reconnecting.
3. Existing transport methods (`toggle`, `play`, `pause`, `next`, `previous`, `seek`) with no command queue in the wrapper.
4. State/status subscriptions that replay the current retained value, isolate listener exceptions, and stop after disposal.
5. A connection-lifecycle subscription/getter with bounded client-local states equivalent to:
   - connecting;
   - connected with current daemon instance ID;
   - reconnecting after retryable loss;
   - terminal with the actionable error;
   - disposed.
6. Idempotent asynchronous disposal (or an equivalent completion handle) that proves the active socket and supervised scope are closed before completion.

Keep connection lifecycle local to `client.ts`; it is not a wire message. Do not add protocol capabilities or server messages for reconnect.

### 4. Implement the scoped reconnect supervisor

Add one Effect-native constructor and one thin Promise-facing owner, named consistently with the existing APIs (for example, `createReconnectingMusicSessionClientEffect` and `createReconnectingMusicSessionClient`).

1. The Effect constructor must require/use `Scope.Scope`, register cleanup immediately, and run its supervisor with `Effect.forkScoped` or equivalent supervised ownership.
2. Initial connection and every replacement attempt must call the existing Phase 3 `connectOrStartMusicSessionEffect`. Reuse its secure discovery, marker, launcher, hello, incompatibility, and bounded scheduling policy; do not duplicate those transitions.
3. The Promise adapter may create one Effect scope at the module boundary, but that scope must be owned by the returned managed client and closed by its disposal. Do not use `Effect.scoped` in a way that closes the supervisor before returning.
4. Keep all mutable lifecycle in Effect synchronization (`Ref`, `Deferred`, latches/semaphore as needed). Do not run an unowned async loop.
5. Initial construction resolves only after the first compatible hello is adopted. Initial incompatibility/startup failure rejects actionably and closes all partial ownership.
6. On retryable terminal loss:
   - atomically mark the generation inactive;
   - retain last status/state and publish `reconnecting` once;
   - let the old explicit client settle its own commands;
   - invoke one bounded `connectOrStart` replacement workflow.
7. On non-retryable terminal error, schedule exhaustion, occupied/unsafe runtime, or incompatibility, publish one terminal state and stop. Incompatibility must preserve its structured range details and trigger no further attempt.
8. Do not treat caller disposal as loss. Disposal interrupts an in-progress startup/reconnect, disposes any active/newly completed explicit client, clears listeners, and prevents future launch/adoption.
9. If a connect completes concurrently with disposal or a newer generation, dispose that explicit client immediately rather than leaking or adopting it.

### 5. Fence every generation

1. Allocate a monotonically increasing local generation token before each connect attempt.
2. Attach explicit status, state, and terminal listeners with that token.
3. Before every callback mutates wrapper state, settles lifecycle, or notifies listeners, atomically verify that the token is still current and the wrapper is live.
4. When adopting a replacement:
   - require completed hello first;
   - unsubscribe/dispose prior generation handles;
   - replace daemon metadata atomically;
   - accept the replacement's replay even when its revision is numerically lower than the prior daemon's revision, because daemon instance ID changed;
   - then publish connected lifecycle.
5. Ignore old-generation state/status frames, terminal callbacks, command completions, and connect completions after token replacement or disposal.
6. For the same daemon instance, retain the explicit client's existing duplicate/stale/out-of-order revision filtering.

### 6. Keep commands truthful and never replay them

1. A transport call snapshots the current active generation and delegates once to that explicit client.
2. If no generation is active (connecting/reconnecting/terminal/disposed), reject immediately with the corresponding stable `MusicSessionClientError`; do not queue the command for later.
3. If loss occurs after admission but before response, preserve the explicit client's one `INDETERMINATE_COMMAND` rejection.
4. Never invoke the same transport operation on a replacement client, even if the old response was absent or the replacement replay suggests it might be safe.
5. A late old-generation response must not settle a later command with the same wrapper call order or alter replacement state.

### 7. Add deterministic reconnect timing and ownership tests

In `packages/music-core/tests/session-client.test.ts`:

1. Add a narrow controllable connector/explicit-client seam only if needed for deterministic generation races. Production defaults must still use the real `connectOrStartMusicSessionEffect` and real explicit client.
2. Under `TestClock`, prove a retryable terminal event starts one bounded replacement workflow, does not busy-loop, and stops after terminal schedule exhaustion/interruption.
3. Prove disposal while sleeping or connecting interrupts the supervisor, prevents all later attempts after advancing virtual time, and disposes a client that completes too late.
4. Prove incompatibility during replacement publishes terminal once, retains exact range details, and performs no later probe/launch after advancing beyond the schedule.
5. Make fake generation callbacks independently controllable so tests can emit old state/status/terminal/response after replacement and verify every one is ignored.
6. Ensure all test fibers/scopes/gates settle in `finally`; do not rely on Bun's outer timeout to clean a suspended supervisor.

### 8. Prove replacement through real selected servers

Use real secure runtime paths, real selected `startMusicSessionServer` instances, and real Unix clients for the integration slice.

1. Start/adopt generation A through the managed constructor and record its daemon instance ID, replay, provider status, and a later state revision.
2. Block one real transport command on generation A, then close/lose A before its response.
3. Assert the command rejects exactly once as `INDETERMINATE_COMMAND` and attach a rejection observer before triggering loss.
4. Let the reconnect workflow start generation B through the existing injected launcher boundary. Generation B must have a different daemon instance ID and provider fixture.
5. While reconnecting, assert generation A's last state remains readable and commands reject immediately rather than queueing.
6. Require generation B hello and replay, including a lower numeric revision, to replace A atomically and notify subscribers in order.
7. Assert generation B's provider transport calls contain no replay of A's blocked command. A new post-connect command may be sent once to prove B is live.
8. Release any old provider gate and deliver any controllable old callback after B adoption; assert no late write, state rollback, lifecycle regression, or duplicate listener notification.
9. Dispose the managed client and prove both server/client scopes, listeners, sockets, markers, and temporary runtime artifacts are released failure-safely.

### 9. Cover listener and lifecycle behavior

Add focused assertions that:

1. State/status listeners receive retained A data immediately when added during reconnect.
2. Replacement B replay is delivered once even with a lower revision and carries B's daemon instance ID.
3. Listener exceptions are isolated and do not block other listeners or reconnect.
4. Unsubscription is idempotent; unsubscribed listeners receive neither replacement nor late old-generation values.
5. Lifecycle order is connecting → connected(A) → reconnecting → connected(B), with no duplicate transitions.
6. Disposal publishes/retains disposed semantics as defined, clears listeners, and is idempotent.

Do not add 24-client fan-out or host presentation assertions here.

### 10. Export only the supported host-neutral surface

In `packages/music-core/index.ts`:

1. Export the managed/reconnecting client type, connection-lifecycle type, options, and Promise constructor needed by future OpenCode/Pi adapters.
2. Keep low-level explicit `createMusicSessionClient` and its existing types exported for compatibility.
3. Do not export test dependency seams, internal generation tokens, fibers/scopes, marker leases, server/provider services, or cleanup guards.
4. Preserve Node-compatible ESM imports and package typecheck.

### 11. Keep this phase isolated

1. Do not implement zero-client idle shutdown, daemon client counting, or signal changes.
2. Do not add queue/backpressure limits or 24-client load evidence.
3. Do not add artwork requests/caches or modify hosts.
4. Format only touched files and inspect the exact diff.
5. Keep work in the current reviewed Jujutsu phase child. Do not run `git commit`, `jj commit`, `jj squash`, push, or open a PR. After approval, the orchestrator may squash only this reviewed phase through the prescribed workflow.

## Acceptance checks

Phase 4 is complete only when:

- A separately typed managed client owns one scoped, supervised reconnect loop while the explicit client remains single-generation.
- Genuine retryable loss retains the last accepted state/status, publishes reconnecting, and invokes the bounded existing startup workflow.
- Every in-flight old-generation command settles exactly once as indeterminate and no command is replayed to the replacement.
- Replacement hello/replay with a new instance ID is adopted atomically even at a lower revision; late old-generation frames/callbacks/completions are ignored.
- Commands during reconnect are rejected immediately rather than queued.
- Incompatibility and other non-retryable terminal outcomes stop supervision with actionable structured errors and no replacement loop.
- Disposal interrupts connect/sleep work, closes the active client/scope, ignores late completions, clears listeners, and is idempotent.
- Listener replay, ordering, exception isolation, and unsubscription are deterministic across A → reconnecting → B.
- The public core index exports only the host-neutral managed client contract and constructor required by later adapters.
- Phase 1–3 suites remain green as baseline only; no idle, fan-out, artwork, host, package, or docs acceptance enters this phase.
- Unrelated dirty content, verified commits, `.apnea/state.json`, and `docs/music-session-architecture.html` remain untouched.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/session-client.test.ts -t 'reconnect|replacement generation|indeterminate'
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
# Baseline regression only; it does not enlarge Phase 4 acceptance.
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts
jj diff --summary
```

Inspect the exact phase diff:

```sh
jj diff --git packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/protocol.ts packages/music-core/index.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
git diff --check
```

Confirm manually:

- the explicit client remains one socket/one generation;
- only retryable terminal loss authorizes reconnect;
- reconnect calls the existing bounded `connectOrStartMusicSessionEffect` rather than duplicating startup;
- every callback and connect completion is generation-fenced;
- no command queue/replay exists in the wrapper;
- retained state survives reconnect and lower-revision replacement replay is accepted by instance ID;
- disposal owns and closes the supervisor scope;
- public exports omit test seams and internal ownership;
- no idle, fan-out, artwork, host, packaging, or docs work entered the phase;
- `.apnea/state.json` and unrelated dirty paths were not altered.

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Approved Phase 1 (`08acaab5`), Phase 2 (`73a988d6`), and Phase 3 (`788473b7`) changes.
- Existing truthful explicit `Client`, terminal request settlement, generation-aware revision filtering, `connectOrStartMusicSessionEffect`, secure discovery, and bounded startup schedule.
- Existing real selected server/fake provider fixtures, scripted daemon controls, and real Unix-socket helpers.
- Repository-pinned Effect v4 scopes, supervised fibers, `Deferred`, `Ref`, `Schedule`, `TestClock`, `Exit`, and synchronization APIs.

## Non-goals

- Zero-client idle grace/daemon exit, daemon client counts, or signal-lifetime changes.
- 24-client fan-out, queue/backpressure policy, slow-reader handling, or global-load hardening.
- Artwork protocol/cache, OpenCode or Pi migration, manifests, packed smokes, READMEs, or architecture HTML.
- Changing protocol negotiation/skew policy, replaying commands, durable command history, remote sockets, process killing/replacement, launchd/service installation, or multi-user sharing.
- New source/test modules, unrelated cleanup, commits or squashing during coding, pushing, publishing, opening a PR, or editing `.apnea/state.json`.
