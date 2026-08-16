---
status: done
---

# Phase 3 package: truthful explicit-client requests and stream semantics

## Intent

Finish the reliability contract of the manually connected, explicit-socket music-session client before any discovery, auto-start, or reconnect work begins.

The client must correlate each command response exactly once, reject malformed daemon data without mis-settling requests, accept only ordered state from its negotiated daemon instance, isolate subscriber exceptions, dispose idempotently, and report a lost in-flight command as indeterminate without replaying it.

Preserve the approved schema/revision negotiation from Phase 2 and all provider, coordinator, server-lifecycle, and process-boundary behavior. Keep unrelated worktree changes and `docs/music-session-architecture.html` untouched. Use only the repository-pinned Effect v4 APIs.

## Files to touch

Only as required:

- `packages/music-core/session/client.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

`packages/music-core/session/server.ts` is not part of this phase. Update server tests only where the explicit client's newly truthful error/result semantics change an assertion.

## Files not to touch

- `packages/music-core/session/server.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/config.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- Anything under `packages/opencode-music-player/`
- Anything under `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

If a proposed fix requires server lifecycle, protocol negotiation, process startup, or host changes, stop rather than broadening the phase.

## Required client semantics

Use these decisions consistently in implementation and tests:

1. **One connection generation:** this phase's client owns exactly the socket it explicitly connected. It never reconnects, spawns, discovers, or replays a command.
2. **Terminal connection error vs pending command outcome:** after transport loss, future calls fail as `CONNECTION_LOST`; every command already handed to that connection but lacking a valid response fails as `INDETERMINATE_COMMAND` because execution cannot be known.
3. **Caller disposal:** disposal is intentional local cancellation, so pending and future calls fail as `DISPOSED`, not indeterminate.
4. **Malformed daemon data:** malformed framing, malformed schema data, or a malformed result makes the connection unusable. Pending commands are still indeterminate; future calls see the terminal invalid-daemon/connection failure.
5. **Typed server failure:** a valid failure response for the matching request rejects only that request with the server's stable code/message/retryability/details; it does not poison the connection.
6. **Valid unsolicited/duplicate response:** ignore it. It cannot settle a current or future request and does not by itself terminate the connection.
7. **Invalid unsolicited frame:** schema-invalid daemon data terminates the connection even if its request ID is unknown; untrusted frames must not bypass validation just because they are unsolicited.
8. **State authority:** accept the first schema-valid state only when `daemonInstanceId` matches the negotiated daemon. Thereafter accept only strictly greater revisions. Ignore wrong-instance, duplicate, stale, and out-of-order snapshots without notifying subscribers.
9. **Status/state listeners:** invoke listeners independently; one throw must not stop another listener or the socket data loop. Unsubscribe and dispose are idempotent, and no listener runs after it is removed or after client termination/disposal.

## Exact implementation steps

### 1. Add a typed transport-result contract

In `packages/music-core/session/protocol.ts`:

1. Add an Effect schema for successful transport response data containing the accepted transport `action` and derive its TypeScript type from the schema.
2. Add one shared decoder/helper for that result. Keep all shape validation schema-owned; do not add record casts or a parallel manual validator.
3. Preserve the Phase 2 request/event/response schemas, protocol ranges, legacy mapping, capability negotiation, and incompatibility details unchanged.
4. Keep the generic response envelope additive, but require the client to decode a matched transport success through the transport-result schema before settlement.
5. Do not add request types, reconnect/generation wire messages, artwork, lifecycle events, or new protocol revisions in this phase.

### 2. Replace loose pending callbacks with an explicit request registry

In `packages/music-core/session/client.ts`:

1. Replace `Map<number, { resolve, reject }>` with entries that retain at least:
   - request ID;
   - request kind (`transport` for the current public methods);
   - requested action;
   - resolve/reject callbacks;
   - enough identity to ensure an old completion cannot remove a newer entry.
2. Centralize settlement in helpers that:
   - verify the map still contains the same entry;
   - delete it before invoking user Promise callbacks;
   - settle it at most once;
   - do nothing for an already settled/removed entry.
3. Keep request IDs strictly increasing and non-negative. Refuse to allocate beyond the safe-integer range rather than wrapping or reusing an ID.
4. Register the pending entry before initiating `socket.write` so immediate socket callbacks cannot race an untracked command.
5. If synchronous encoding/write initiation fails or the write callback reports failure after admission to this connection, terminate through the same truthful connection-loss path. Never retry the command.
6. Change transport methods from `Promise<unknown>` to the schema-derived transport result type if that can be done without touching package exports. Preserve all existing method names and seek validation.

### 3. Validate matched responses before settlement

In `packages/music-core/session/client.ts`:

1. Decode every received frame through the Phase 2 `decodeServerFrame` boundary before looking up a pending request.
2. For a response:
   - find the exact pending entry by request ID;
   - ignore the response if no entry exists (unsolicited or duplicate);
   - for a valid failure response, reject that exact entry with `MusicSessionClientError` preserving the full stable protocol error;
   - for a success response, decode its `data` according to the pending request kind;
   - for transport, require the returned action to equal the action requested, including `toggle` remaining `toggle`.
3. A malformed or mismatched success payload is invalid daemon data. Do not resolve the request, do not leave it pending, and do not allow a later frame to settle it. Terminate the connection and fail all in-flight commands once as indeterminate.
4. Out-of-order valid responses for different IDs must settle the corresponding Promises, not request insertion order.
5. A duplicate response after the first settlement must be ignored and must not affect another request, even after subsequent requests are allocated.
6. Preserve valid typed provider/queue errors as request-local failures; a later command on the same healthy connection must still work.

### 4. Use one listener set from handshake through active operation

The current handshake removes temporary socket listeners and later installs anonymous active listeners. Refactor this handoff so data cannot be lost between hello and active attachment:

1. Own exact `data`, `end`, `error`, and `close` callback references for the lifetime of the socket.
2. Route frames through an explicit internal connection state such as `handshaking`, `active`, and `terminal/disposed` rather than detaching one reader and attaching another.
3. During handshaking:
   - only response ID `0` can complete hello;
   - validate the negotiated hello exactly as Phase 2 requires;
   - preserve status/state frames that arrive in the same chunk or immediately after hello;
   - transition to active before exposing readiness so no data-event gap exists.
4. A valid but unrelated response cannot complete hello. A malformed frame, socket error, EOF, or close rejects handshake once and destroys the socket.
5. During active operation, route every complete frame through the response/status/state logic exactly once.
6. On `end`, finalize the `NdjsonFramer`. A buffered partial frame is malformed daemon data; a clean EOF is ordinary connection loss. Ensure subsequent `close`/`error` events reuse the first terminal transition.
7. Remove all exact socket listeners during the one terminal/dispose transition. Do not leave anonymous callbacks attached to a destroyed socket.
8. Keep the public `createMusicSessionClient(options)` Promise boundary. Do not add a second runtime, detached loop, or Effect service in this phase.

### 5. Separate terminal state from in-flight command settlement

In `packages/music-core/session/client.ts`:

1. Model terminal state once. The first terminal transition records the future-call error, detaches listeners, clears subscribers, settles handshake if needed, settles all current pending entries with the appropriate pending error, and destroys the socket if necessary.
2. On network `error`, clean EOF, or `close` while active:
   - record `CONNECTION_LOST` for future calls;
   - reject every pending command as `INDETERMINATE_COMMAND`;
   - use a message that states the connection ended before the command result.
3. On malformed daemon framing/schema/result:
   - record non-retryable `CONNECTION_LOST` with an invalid-daemon message for future calls;
   - reject pending commands as `INDETERMINATE_COMMAND`, because their outcomes are unknown.
4. On `dispose()`:
   - transition once to disposed;
   - reject pending commands as `DISPOSED`;
   - make future calls reject as `DISPOSED`;
   - detach listeners, clear subscribers, and destroy the socket once.
5. A response, write callback, error, end, close, and dispose racing in any order must still settle every Promise once and preserve the first truthful terminal state.
6. Preserve `ProtocolError.details` on `MusicSessionClientError` so structured Phase 2 incompatibility information is not discarded at the public client boundary.
7. Do not retain a command for possible replay. Once removed or terminally failed, it is gone.

### 6. Make state and listener delivery explicit and isolated

In `packages/music-core/session/client.ts`:

1. Keep current status and state as presentation cache only.
2. Before publishing a state frame, verify negotiated daemon instance and strict revision increase. Do not mutate cached state for rejected snapshots.
3. Notify a stable iteration of current listeners so one listener throwing or unsubscribing cannot corrupt delivery to the remaining listeners.
4. Catch listener exceptions per callback; do not turn a UI callback defect into socket failure.
5. A late subscriber receives the latest accepted status/state once, and its immediate callback is isolated like live callbacks.
6. An unsubscribe function is idempotent. After unsubscribe, terminal transition, or dispose, that listener receives no later event.
7. Ignore all late socket callbacks and frames after terminal/disposed state.
8. Do not add reconnect status, retained-generation switching, or host-specific notifications; those belong to later phases.

### 7. Add a deterministic scripted-daemon test seam in the existing client test file

In `packages/music-core/tests/session-client.test.ts`:

1. Build small in-file helpers around a real `net.Server`, real Unix path, `NdjsonFramer`, and Node event Promises. Do not create a new fixture module.
2. The helper must:
   - capture frames received from the client;
   - send a valid negotiated hello result;
   - send arbitrary complete/split/multiple daemon frames;
   - end, error, or destroy the accepted socket on demand;
   - expose deterministic accepted/received/closed signals.
3. Every test must use failure-safe ownership:
   - declare server/socket/client handles before `try`;
   - assign immediately after acquisition;
   - dispose client, destroy sockets, close listener, and remove path in `finally`;
   - release any queue/latch/deferred gates even when assertions fail.
4. Use `randomUUID()` for unique paths and Node events or Effect `Deferred`/`Queue`/`Latch` for synchronization. Do not use `setTimeout`, `Bun.sleep`, `Date.now`, repeated `Effect.yieldNow`, or polling loops.

### 8. Add focused request-settlement tests

In `packages/music-core/tests/session-client.test.ts`:

1. Send two concurrent commands and return valid responses in reverse order. Assert each Promise receives only its matching action/result.
2. Send a valid unsolicited response, then a valid response for a pending request. Assert the unsolicited frame settles nothing and the real response settles once.
3. Send the same valid response twice, then issue/settle another request. Assert the duplicate cannot affect either the completed request or the newer one.
4. Send a success response with malformed data or the wrong action for a pending transport. Assert the command rejects once as `INDETERMINATE_COMMAND`, the client becomes terminal, and a future command rejects as `CONNECTION_LOST`.
5. Send a valid typed failure for one command, then a valid success for another. Assert only the first fails and the connection remains usable.
6. Start one or more commands, then trigger socket error/end/close races. Assert every in-flight command rejects exactly once as `INDETERMINATE_COMMAND`; future calls reject as `CONNECTION_LOST`; the daemon observes no replay or second connection.
7. Start a command, call `dispose()` repeatedly, then deliver late response/error/close callbacks. Assert the command rejects once as `DISPOSED`, future calls are `DISPOSED`, and no late callback changes the outcome.
8. Preserve the existing invalid-seek local rejection and prove it sends no frame.

### 9. Add focused stream-authority and listener tests

In `packages/music-core/tests/session-client.test.ts`:

1. After hello, send a valid initial state, then:
   - duplicate revision;
   - lower revision;
   - higher revision followed by an out-of-order middle revision;
   - higher revision from a wrong daemon instance;
   - a final valid higher revision from the negotiated instance.
2. Assert only strictly increasing, correct-instance states update `client.state` and notify subscribers, in wire order.
3. Subscribe multiple listeners where one throws and another records values. Assert the healthy listener receives all accepted updates and command/reader processing remains live.
4. Unsubscribe one listener twice and prove it receives no later state/status.
5. Subscribe after an accepted replay and prove immediate delivery of the latest accepted value exactly once.
6. Send malformed nested status/state or malformed NDJSON/partial EOF. Assert the client terminates once, clears listeners, and never publishes malformed/late data.
7. Prove dispose removes active listener effects: late frames after disposal cause no state/status callbacks.

### 10. Update only the affected server integration assertion

In `packages/music-core/tests/session-server.test.ts`:

1. Retain all Phase 1 failure-safe cleanup and Phase 2 compatibility tests unchanged.
2. In the existing blocked socket-command scenario, assert the explicit client reports code `INDETERMINATE_COMMAND` when server scope closes before a response.
3. Retain the existing proof that releasing the blocked provider afterward causes no late response/write. This is regression evidence for the client outcome, not a new server lifecycle matrix.
4. Do not add new server acceptance, lifecycle hooks, or production server changes.

### 11. Keep the phase diff and Jujutsu workflow narrow

1. Format only touched files.
2. Run client tests first, then protocol/server regressions and all `music-core` targets.
3. Inspect `jj diff --summary` and the exact diff. Preserve `.apnea/state.json`, `docs/music-session-architecture.html`, and unrelated paths.
4. Keep work in the current phase child for review. Do not run `git commit`, push, or `jj squash` during the coding round. After approval, use the run's prescribed `jj squash` step for only this reviewed phase.

## Acceptance checks

Phase 3 is done only when:

- Concurrent and out-of-order valid responses settle only the matching request once; valid unsolicited and duplicate responses settle nothing else.
- A matched transport success is schema-valid and matches the requested action before resolving. Malformed/mismatched daemon results terminate the connection and leave in-flight command outcomes indeterminate.
- Wrong-instance, duplicate, stale, and out-of-order snapshots are ignored; correct-instance strictly increasing replay/live states are cached and delivered in order.
- Listener exceptions and self/unsubscription are isolated; late subscribers receive current accepted values; no listener runs after unsubscribe, termination, or disposal.
- Handshake-to-active reading has no listener gap, and malformed framing/schema/partial EOF transitions the client once to an invalid connection.
- Valid typed command failure remains request-local and does not prevent a later command.
- Network loss before a command response rejects that command once as `INDETERMINATE_COMMAND`; future calls reject as `CONNECTION_LOST`; no command is replayed and no second connection is opened.
- Repeated disposal rejects pending/future calls as `DISPOSED`, detaches listeners, destroys the socket once, and ignores late response/error/end/close callbacks.
- Existing Phase 2 schema/legacy/current negotiation and approved server/provider/coordinator suites remain green without becoming new Phase 3 acceptance work.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n "setTimeout\(|Bun\.sleep|Date\.now\(|Effect\.yieldNow" packages/music-core/tests/session-client.test.ts
jj diff --summary
```

Inspect the diff after the commands:

- product changes are confined to `client.ts` and the narrow transport-result schema addition in `protocol.ts`;
- `session-server.test.ts` changes only the affected explicit-client assertion unless a focused regression proves another test expectation must change;
- no server production, framing, config, provider, coordinator, executable, discovery, spawning, reconnect, idle, load, artwork, host, manifest, or documentation work entered the phase;
- `.apnea/state.json` and unrelated dirty paths remain untouched.

## Dependencies

- Approved Phase 2 commit `f059efc8`, including schema-owned request/event/response decoding, legacy/current revision negotiation, capability intersection, and explicit negotiated hello validation.
- Approved Phase 1 process/server boundary commit `e70641bc`, scoped server commit `66bc1f91`, coordinator commit `859fc01d`, and provider commit `e7103663`.
- Existing real Unix-socket test helpers, fake provider, NDJSON framer, and failure-safe server test ownership.
- Repository-pinned Effect v4 schema APIs and Bun/Node Unix-domain socket support.

## Non-goals

- Runtime-path discovery/security, stale endpoint classification, startup marker, daemon spawn, singleton race, or healthy-generation skew replacement policy.
- Reconnect supervision, replacement generation adoption, retaining state while reconnecting, retry/backoff, or idle shutdown.
- Server lifecycle/resource changes, new server hooks, provider/coordinator behavior, replay production changes, polling, reconciliation, command queue semantics, or another server cleanup audit.
- Per-client/global bounds, socket write backpressure, slow-reader coalescing, 24-client evidence, artwork, or caching.
- OpenCode/Pi migration, host UI/status/toast behavior, package exports/manifests, packing, smokes, READMEs, or architecture HTML.
- New source/test modules, publishing, committing, squashing before approval, pushing, opening a PR, editing `.apnea/state.json`, or resetting/cleaning unrelated worktree content.
