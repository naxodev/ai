---
status: done
---

# Phase 6 package: bound fan-out and prove 24-client operation

## Intent

Harden the selected daemon/client data paths so 20+ local clients cannot create unbounded memory, pending work, or cross-client stalls.

Add explicit finite bounds for inbound chunks/frames, per-client pending requests, the existing global command lane, mandatory outbound frames, coalescible state, and Node socket write pressure. A slow or abusive client must be isolated locally. State may coalesce for that client, but command responses and required status transitions must never be silently dropped: they are delivered in order or the offending connection is terminated so its pending requests settle truthfully.

Prove the target topology with twenty-four real Unix clients using alternating OpenCode/Pi identities, one provider/event/coordinator/poll owner, immediate replay, a later update, global FIFO commands, bounded overflow, and one paused reader that cannot delay the other twenty-three.

Use repository-pinned Effect v4 bounded/sliding queues, streams, scopes, fibers, and synchronization. Do not add artwork, host controllers, or remote transport.

## Files to touch

Only as required:

- `packages/music-core/session/config.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`

Touch `protocol.ts` only for stable bounded-error/schema behavior; reuse existing `SERVER_BUSY` where possible. Do not create a new source or test module.

## Files not to touch

- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts` except for a narrowly required global-command bound correction (prefer tests only because the bound already exists)
- `packages/music-core/session/framing.ts` unless the existing framer cannot enforce a required frame/read bound without a local server/client check
- `packages/music-core/system-media.ts`
- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/tests/session-protocol.test.ts` unless `protocol.ts` changes
- `packages/music-core/tests/system-media.test.ts`
- Anything under `packages/opencode-music-player/` or `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

Preserve Phase 1–5 graph, singleton, startup, reconnect, and idle behavior.

## Exact implementation steps

### 1. Inventory existing bounds and preserve their semantics

Before editing, confirm and retain:

1. `maxFrameBytes` rejects oversized/incomplete NDJSON frames.
2. The connection input chunk queue is currently bounded but hard-coded.
3. `commandQueueCapacity` bounds the coordinator's one active command plus queued/pending jobs and reports `SERVER_BUSY` without killing the worker.
4. Provider state is replayed through `SubscriptionRef`; provider/coordinator ownership is O(1), while fan-out is per connection.
5. Phase 5 counts negotiated clients and owns idle shutdown independently of raw sockets.

Do not replace these with an unrelated broker or reopen lifecycle acceptance.

### 2. Add validated load-bound configuration

In `packages/music-core/session/config.ts`:

1. Add finite positive safe-integer settings for the server-side bounds that are currently implicit. Use clear names equivalent to:
   - inbound chunk queue capacity per connection;
   - maximum decoded frames accepted from one socket read/chunk;
   - mandatory outbound queue capacity per connection.
2. Keep existing `maxFrameBytes` and `commandQueueCapacity` as the frame-size and global-command bounds; do not duplicate them under new names.
3. Add defaults, resolved fields, and matching entries to the existing environment-backed `Config` Layer alongside other load settings.
4. Validate zero, negative, fractional, non-finite, and unsafe values through `MusicSessionConfigError`.
5. If the explicit client needs a pending-request bound, add a validated `maxPendingRequests` option/default in `client.ts`; do not couple a host client's memory limit to the daemon's environment config implicitly.
6. Add focused config/client-option tests only for the new settings.

Choose practical defaults that support twenty-four healthy clients while keeping each individual connection finite.

### 3. Bound server inbound work per connection

In `packages/music-core/session/server.ts`:

1. Replace the hard-coded 64-entry input queue with the resolved per-connection inbound capacity.
2. Make the completion queue capacity one; it carries only one terminal signal and must not be unbounded.
3. Keep Node callbacks nonblocking. `onData` may use `Queue.offerUnsafe`; if the bounded input queue is full, destroy only that socket and record a bounded connection-overflow diagnostic.
4. After framing a chunk, reject/close the connection if one read decodes more than the configured frame-count bound. The total decoded array must remain bounded even when many tiny JSON lines fit below `maxFrameBytes`.
5. Preserve serial request processing and strict request IDs. A blocked request may fill only that connection's finite input queue; it cannot allocate unlimited queued buffers.
6. Malformed, oversized, burst-overflow, EOF, and abrupt-close paths must finalize input/processor/connection ownership exactly once and leave the listener/other clients healthy.
7. Do not turn local overload into `serverFaults` or daemon shutdown.

### 4. Bound explicit-client pending requests and writes

In `packages/music-core/session/client.ts`:

1. Add a finite pending-request limit to each explicit client before inserting into its pending map.
2. At capacity, reject the new call immediately with stable `MusicSessionClientError` code `SERVER_BUSY`; do not allocate a request ID/frame or write it to the socket.
3. Preserve existing exactly-once settlement and cleanup on response, terminal loss, malformed data, and disposal.
4. Keep the reconnecting wrapper queue-free. It delegates once to the active explicit client and inherits the same bound; it never stores commands for a later generation.
5. Socket write failure still terminates the explicit generation truthfully. Do not create an unbounded client-side write queue.

Add focused tests showing capacity rejection, recovery after a request settles, and no command replay across reconnect.

### 5. Give each server connection one bounded outbound writer

Replace direct `socket.write` calls from frame processors and subscription forwarders with a connection-scoped writer in `packages/music-core/session/server.ts`.

1. Create one writer fiber per connection. It must be the only code that writes frames to that socket.
2. Maintain separate bounded semantics:
   - a bounded mandatory lane for hello/results, command/error responses, and provider status transitions;
   - a capacity-one latest-state slot/signal for revisioned state events.
3. `sendRequired` must enqueue without blocking coordinator/forwarder fibers. If mandatory capacity is exhausted, close that connection locally; never silently discard or overwrite a required response/status.
4. `sendState` may overwrite only an older unsent state for the same client. It must retain the latest full snapshot and eventually deliver it if the connection remains writable.
5. Ensure hello response is admitted before status/state forwarders start. Mandatory frames preserve FIFO order with each other. State coalescing must not reorder hello ahead of itself or emit a stale snapshot after a newer one.
6. Encode/check outbound frame size before enqueue/write. If a provider-derived frame exceeds `maxFrameBytes`, contain the failure to that client and diagnostics; do not grow a Node buffer or kill the daemon.
7. On mandatory overflow, frame-size failure, socket error, or writer failure, destroy only that socket and let the explicit client settle pending commands as connection-lost/indeterminate.
8. Shut down mandatory/state queues and interrupt/join the writer in the connection finalizer. No writer, drain listener, frame, or queue may survive socket scope completion.

### 6. Honor Node write backpressure

1. When `socket.write` returns `false`, the writer must stop taking additional outbound frames until `drain`, socket close/error, or scope interruption.
2. Implement the drain wait through an interruptible Effect callback with listener removal in its canceler/finalizer. Do not use a raw Promise loop or timer.
3. While blocked, mandatory memory remains bounded by its queue and state remains one coalesced latest value.
4. Add observation-only hooks for queue overflow, state coalescing, and write-backpressure entry only if tests need deterministic barriers. Hooks must not carry frame/playback payloads or affect production flow.
5. A peer that never drains may be disconnected on mandatory overflow or shutdown; a state-only slow reader may remain with one pending latest state. Either outcome must be local and bounded.

### 7. Preserve global FIFO and overflow recovery

In `session-coordinator.test.ts` and real server tests:

1. Retain the existing single global coordinator worker and `commandQueueCapacity` admission semantics.
2. With provider transport blocked, submit commands from different real clients in a known admission order.
3. Assert the accepted commands execute globally FIFO, not once per client.
4. Exceed one-active-plus-queue capacity and require `SERVER_BUSY` for excess work without disposing the provider, listener, or worker.
5. Release transport, await all accepted results, then send another command and prove the worker remains healthy.
6. A slow outbound client cannot hold the global command worker after the coordinator has completed its result; enqueue/overflow belongs to that connection only.

Do not redesign command reconciliation or authority semantics.

### 8. Prove 24-client replay and fan-out with one provider owner

In `packages/music-core/tests/session-server.test.ts` (and client tests only where wrapper behavior is involved):

1. Start one real selected server over a secure real Unix path with `createFakeProvider`/existing instrumented hooks and load bounds large enough for healthy operation.
2. Create twenty-four clients concurrently before collecting replay, using unique IDs and alternating `hostKind: "opencode"` / `hostKind: "pi"`.
3. Await all callers to settlement rather than fail-fast `Promise.all`; retain and dispose every client returned before any failure.
4. Assert all twenty-four:
   - complete hello against one nonempty daemon instance ID;
   - negotiate the same revision/capabilities;
   - receive initial provider status and state replay;
   - count as negotiated clients without triggering idle grace.
5. Assert server/provider ownership is one listener, one coordinator, one provider Layer, one provider event subscription, and one polling/sampling lane—not one per client.
6. Emit one later authoritative snapshot/revision and require all twenty-four clients to converge on it.
7. Dispose one client and prove the other twenty-three receive another update; no daemon idle grace starts while clients remain.
8. Dispose all remaining clients/close the server in `finally`; verify exact-once provider/listener cleanup and no socket/marker/bind-reservation debris.

### 9. Prove a paused reader cannot delay the other 23

1. Among the twenty-four identities, use one real raw/explicit client whose socket completes compatible hello and then pauses reads.
2. Drive enough bounded state revisions (using a test-sized frame within `maxFrameBytes`) to make the server writer observe real Node backpressure for that socket. Use a hook/latch as the deterministic barrier; do not assume a fixed number of writes without observation.
3. Continue emitting updates and prove the slow connection stores/coalesces at most one pending state.
4. Require the other twenty-three clients to receive a later revision promptly while the slow writer remains blocked.
5. Send real commands from healthy clients and prove global FIFO/results continue.
6. If required mandatory traffic fills the paused client's bounded lane, assert only that client disconnects and its pending request settles; the other twenty-three, provider, coordinator, listener, and idle count remain healthy.
7. Resume/destroy the paused socket in `finally` and bound any wait with an Effect sentinel that reaches cleanup on failure.

### 10. Prove abusive inbound/outbound overflow is local

Add focused real-socket tests with deliberately small capacities:

1. Flood one client while a request blocks until its inbound chunk/frame bound is exceeded; assert that socket closes and connection failure/overflow count increments once.
2. Fill one paused client's mandatory outbound lane using correlated requests/responses; assert local close rather than silent response loss or unbounded memory.
3. Keep a healthy client connected throughout. After abusive peer closure, require healthy state update and command success.
4. Assert the daemon process/selected graph does not fail and the coordinator worker accepts later work.
5. Assert all overflow diagnostics are bounded metadata only—client count/operation/capacity, not state, command, or frame content.

### 11. Keep tests failure-safe and deterministic

1. Retain clients/sockets/readers/scopes/fibers immediately after acquisition; avoid all-or-nothing assignments.
2. Await concurrent clients with `Promise.allSettled` or Effect collection so late successful clients cannot escape cleanup after one failure.
3. Use Effect latches/queues/hooks for backpressure, command admission, and convergence barriers. Raw wall-clock sleeps/poll loops are forbidden.
4. In `finally`, release blocked provider gates, resume/destroy paused sockets, dispose every client, close the server/scope idempotently, and remove only test runtime artifacts.
5. Bound waits with an Effect timeout that throws into the test's own `try`/`finally`; Bun's outer timeout is not resource cleanup.

### 12. Keep Phase 6 isolated

1. Do not add artwork requests, cache entries, payload capability, or image bytes.
2. Do not migrate OpenCode/Pi production code; identities here are protocol test clients only.
3. Do not alter startup, singleton, reconnect, or idle policy except for direct regressions exposed by load tests.
4. Format only touched files and inspect the exact diff.
5. Keep work in the current reviewed Jujutsu phase child. Do not run `git commit`, `jj commit`, `jj squash`, push, or open a PR. After approval, the orchestrator may squash only this reviewed phase through the prescribed workflow.

## Acceptance checks

Phase 6 is complete only when:

- Frame bytes, decoded frames/read, inbound chunks, explicit-client pending requests, global commands, mandatory outbound frames, coalesced state, and Node write pressure all have finite explicit bounds.
- Each connection has one scoped writer; mandatory frames are FIFO/delivered or the peer is closed, while only unsent state may coalesce to the latest snapshot.
- A paused or abusive peer cannot block coordinator work, fan-out, commands, shutdown, or healthy peers and cannot kill the daemon.
- Twenty-four alternating OpenCode/Pi clients share one daemon instance/provider/event/poll owner, receive immediate replay and later updates, and remain healthy when one client leaves.
- One paused reader does not delay the other twenty-three; real backpressure is observed and memory remains bounded.
- Cross-client commands remain globally FIFO; capacity overflow reports `SERVER_BUSY`, accepted work settles, and the worker accepts later commands.
- Overflow/frame/write failures are local, bounded, diagnostic, and failure-safe.
- Phase 1–5 suites remain green as baseline only; no artwork or host migration enters this phase.
- Unrelated dirty content, verified commits, `.apnea/state.json`, and `docs/music-session-architecture.html` remain untouched.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t '24|slow reader|backpressure|overflow'
bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
# Baseline regression only; it does not enlarge Phase 6 acceptance.
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts
jj diff --summary
```

Inspect the exact phase diff:

```sh
jj diff --git packages/music-core/session/config.ts packages/music-core/session/protocol.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
git diff --check
```

Confirm manually:

- no direct multi-source `socket.write` remains in server connection handling;
- mandatory queues are bounded and state storage is capacity one/latest-only;
- write backpressure waits for `drain` with interruption-safe listener cleanup;
- all overload paths close only the offending connection;
- client pending maps and coordinator pending/queue state are bounded;
- the 24-client test awaits every concurrent result and cleans every client;
- provider/coordinator ownership remains O(1) and fan-out O(N);
- no artwork, host, packing, or docs changes entered the phase;
- `.apnea/state.json` and unrelated dirty paths were not altered.

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Approved Phase 1 (`08acaab5`), Phase 2 (`73a988d6`), Phase 3 (`788473b7`), Phase 4 (`b376a94d`), and Phase 5 (`82853612`) changes.
- Existing bounded coordinator queue/`SERVER_BUSY`, `SubscriptionRef` replay, real selected server, fake provider controls, explicit/reconnecting clients, negotiated-client idle tracking, and Unix-socket helpers.
- Repository-pinned Effect v4 bounded/sliding queues, streams, scopes, supervised fibers, latches, `Deferred`, `Ref`, and synchronization APIs.

## Non-goals

- Artwork protocol/capability, native artwork reads, Effect cache, image payloads, iTunes lookup, conversion, or rendering.
- OpenCode/Pi production adapters, UI/status/waveform behavior, manifests, packed smokes, READMEs, or architecture HTML.
- Remote/TCP access, durable history, per-host daemon authority, process killing/replacement, launchd/service installation, or multi-user sharing.
- New source/test modules, unrelated cleanup, commits or squashing during coding, pushing, publishing, opening a PR, or editing `.apnea/state.json`.
