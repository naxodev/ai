---
status: done
---

# Phase 3 package: scoped foreground socket server and connection ownership

## Intent

Make the existing explicit-path foreground Unix-socket server genuinely owned by one Effect v4 scope. The listener, successfully bound socket path, accepted sockets from the instant of acceptance, Node event listeners, connection queues/framers, replay-forwarding fibers, command handlers, signal listeners, and shutdown must all have supervised, exact-once lifetimes.

Preserve the current hello-first/replay/state/transport wire behavior. Do not expand schemas, add revision-range negotiation, change the explicit client, add automatic daemon launch/reconnect, or require later lifecycle/load/host evidence. Phase 4 owns the shared protocol; this phase owns only the current protocol boundary’s resource lifetime and isolation.

Preserve all accumulated dirty-worktree implementation and `docs/music-session-architecture.html`. Build on the approved Phase 1 provider and Phase 2 coordinator Layers. Use Effect TypeScript v4 only.

## Files to touch

Primary files:

- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-server.test.ts`

Touch only if the scoped server implementation requires a narrow correction:

- `packages/music-core/session/config.ts` — server-only listener/test configuration plumbing; do not add later lifecycle settings.
- `packages/music-core/session/framing.ts` — connection-local finalization/EOF support only; do not redesign framing or errors.
- `packages/music-core/tests/session-coordinator.test.ts` — only if a server integration control cannot be exposed by the already approved Effect-native provider fixture.

Do not change Phase 1 provider production semantics or Phase 2 coordinator production semantics in this phase. If an actual regression is discovered there, stop rather than silently broadening the phase.

## Files not to touch

- `packages/music-core/system-media.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/tsconfig.json`
- `bun.lock`
- Anything under `packages/opencode-music-player/`
- Anything under `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and other `.apnea` tasks/artifacts

If a proposed fix requires changing the wire contract, explicit client, process discovery, host code, or manifests, defer it to its assigned later phase.

## Required ownership model

The result must have these nested lifetimes:

1. One top-level daemon scope owns the production config → provider → coordinator → server Layer graph and scoped signal wait.
2. The server scope owns one `net.Server`, its persistent listeners, the path it successfully bound, an accepted-connection supervisor, and the set/registry of live sockets.
3. Every accepted socket immediately enters one server-owned connection scope or is synchronously destroyed if enrollment is no longer possible.
4. A connection scope owns that socket, every `data`/`end`/`error`/`close` listener, input delivery, `NdjsonFramer`, hello/request state, status/state forwarding fibers, and command effect.
5. Natural disconnect closes the connection scope without closing the listener. Server scope closure interrupts every connection scope before listener/path cleanup completes.
6. The Promise-facing `startMusicSessionServer` and Node executable are outer adapters only; they do not create a second imperative resource graph.

A Node callback may only offer/enroll work into a captured scoped Effect runtime and return. It must not call an untracked `Effect.runPromise`, start a detached Promise loop, or own a timer.

## Exact implementation steps

### 1. Introduce a testable scoped socket boundary

In `packages/music-core/session/server.ts`:

1. Keep `MusicSessionSocketError` as a `Schema.TaggedErrorClass` with stable `operation`, useful `message`, and original cause.
2. Factor production Node operations behind a narrow in-file dependency/test-hook constructor used by the production `layer` and focused tests. It may cover:
   - `net.createServer`;
   - listen/bind completion;
   - server close completion;
   - path unlink;
   - lifecycle counters/hooks for accepted, enrolled, finalized connections and forwarding fibers.
3. Production defaults must use real `node:net` and `node:fs/promises`. Do not create another module or expose Node internals through the public package index.
4. Test failure injection must still perform all real cleanup needed by the test. A synthetic close/unlink failure must not intentionally leak a listener or socket.
5. Map synchronous server creation, asynchronous listen, post-bind listener failure, close, and non-`ENOENT` unlink errors once at this boundary. Preserve interruption separately.

### 2. Acquire the listener and bound path safely

1. Acquire `net.Server` in a scoped effect before registering callbacks. If creation/listen fails, remove temporary listeners and close the unbound/partially bound server where applicable.
2. Register listen-time and persistent server listeners in scope and remove each exact function in the finalizer. Do not leave an anonymous callback that cannot be removed.
3. Mark path ownership only after this server successfully binds it. Cleanup may unlink only that owned path.
4. A bind failure on an existing healthy socket must not unlink or disrupt that path’s owner.
5. Route a post-bind server error into the server Effect lifetime as `MusicSessionSocketError`; do not leave an unhandled EventEmitter `error` that can crash outside the runtime.
6. Stop accepting/enrolling new sockets as soon as shutdown begins.
7. Do not add default runtime-directory discovery, stale-socket probing/removal, permission policy, startup markers, or singleton launch. Those belong to Phase 5.

### 3. Enroll every accepted socket immediately

1. Replace the current loose mutable `Set` plus fire-and-forget enrollment with one scoped connection supervisor (`FiberSet`, scoped queue/stream, or equivalent).
2. The `connection` callback must do exactly one of:
   - synchronously enroll the socket into the live server supervisor; or
   - destroy it immediately because shutdown/enrollment has failed.
3. Register socket tracking/finalization before user data can escape ownership. Cover the race where server shutdown starts in the same turn as acceptance.
4. Track pre-hello, handshaking, post-hello, mid-frame, and blocked-command sockets identically.
5. On natural close, remove the exact tracking listener and complete that connection fiber/scope. On server close, interrupt all connection fibers and destroy all sockets before awaiting listener close.
6. Connection failure must remain local: malformed/current-protocol-invalid input or socket error may close that socket but must not fail the accept supervisor or another client.

### 4. Scope connection-local listeners and input processing

1. Acquire `data`, `end`, `error`, and `close` listeners with exact references. Remove them in one idempotent finalizer.
2. Ensure input queue/stream shutdown is executed as an Effect. The current pattern calls `Queue.shutdown(input)` inside `Effect.sync`, which merely constructs and discards the shutdown effect; replace it with actual execution.
3. Keep connection input delivery bounded to a reasonable phase-local capacity or process it serially without an accumulating queue. Do not implement Phase 7’s complete per-client backpressure/coalescing policy here.
4. Keep one `NdjsonFramer` per connection. On `end`, finalize/check its buffered state before closing; framing failure remains connection-local under the current behavior.
5. Run request processing serially for each connection so request order and current duplicate-ID behavior remain stable.
6. Wrap synchronous `framer.push`, encoding, and socket write initiation at the socket boundary. A write to a closed/failing socket terminates only that connection.
7. Do not redesign `FrameError`, schemas, protocol error payloads, request rules, max-frame policy, or write-pressure semantics; Phases 4 and 7 own those changes.

### 5. Scope replay forwarding and command handling

1. Preserve current hello-first validation and current protocol-major/capability checks exactly.
2. After a successful hello response, fork status and state forwarding as connection-scoped supervised fibers. `SubscriptionRef` replay from Phase 2 must still deliver current status/state immediately.
3. Register deterministic lifecycle hooks/counters in the focused test constructor for each forwarding fiber’s start/finalization. Do not infer finalization from a delay.
4. A natural disconnect or server shutdown interrupts both forwarding fibers before socket finalization completes.
5. A provider event emitted after connection finalization must cause no write attempt for that connection.
6. Run a transport submission as child work of the connection scope. If the socket closes while a command is blocked, interrupt the waiting request effect; coordinator/provider global work follows its own Phase 2 settlement semantics without permitting a late response write.
7. Continue mapping existing schema-tagged `SessionCommandError` codes into the unchanged current protocol error envelope.
8. Listener/connection defects must be observed and isolated; they may not silently detach or kill the server supervisor.

### 6. Make shutdown ordered, complete, and observable

Implement one idempotent cleanup sequence with this order (or an equivalent dependency-safe order):

1. atomically mark server closing and reject/destroy newly accepted sockets;
2. destroy live sockets and interrupt/await every connection scope and forwarding fiber;
3. remove persistent listener callbacks;
4. close/await `net.Server`;
5. unlink only the path this scope successfully bound;
6. allow enclosing coordinator/provider Layers to finalize.

Additional requirements:

- Continue all cleanup steps even if server close or unlink fails.
- Ignore unlink `ENOENT` only. Preserve every other unlink failure as `MusicSessionSocketError` with operation `unlink`.
- Preserve close failure as `MusicSessionSocketError` with operation `close`.
- If multiple cleanup operations fail, retain typed operation/cause information rather than replacing it with `undefined`. It is acceptable to choose one primary typed failure if the other is retained/logged diagnostically and every cleanup runs.
- The scoped Layer/daemon must observe cleanup failure; do not `Effect.ignore`, `catch: () => undefined`, or convert it to success.
- Repeated shutdown/`close()` calls must reuse the same cleanup outcome and never repeat socket destruction, server close, unlink, or outer Layer finalization.
- A failed first cleanup may make repeated `close()` report the same typed failure; it must not rerun resources.

### 7. Keep the public Promise adapter thin

1. Preserve the current test-facing signature and behavior:

   ```ts
   startMusicSessionServer(options, provider?)
   ```

2. The adapter may use `Effect.runPromise` to create/build one explicit Effect scope and to close it. Those are public-boundary calls only.
3. It must compose the same config/provider/coordinator/server Layers as production; do not construct an imperative coordinator/server in parallel.
4. `close()` closes that scope exactly once and awaits all cleanup. Propagate typed startup/cleanup failure to the Promise caller.
5. If Layer build/listen fails, close the partial scope and preserve the original typed startup failure while still attempting cleanup.
6. Keep the legacy Promise/callback provider adapter only for current socket tests. Production still uses the approved Effect provider Layer.

### 8. Run the executable’s Layer graph directly

In `packages/music-core/session/music-sessiond.ts`:

1. Keep current `--socket <absolute-path>`, `--help`, and `-h` behavior. CLI parse errors are an outer process boundary; do not add auto-discovery.
2. Compose config → provider → coordinator → server once and run one `Effect.scoped` daemon program.
3. Do not call `startMusicSessionServer` from the executable or attach an imperative `close()` as a finalizer.
4. Adapt `SIGINT` and `SIGTERM` into one scoped Effect wait. Register exact handler references and remove both on completion/interruption.
5. A signal must end the wait and let Layer scope closure perform all server/coordinator/provider cleanup in dependency order.
6. Keep one top-level `Effect.runPromise`/`await` as the Node process boundary. Do not add another runtime per signal/resource.
7. Startup/shutdown logging may include socket path and daemon instance ID but not playback payloads.
8. Cleanup failure must set nonzero process status and retain tagged operation/message in diagnostics.

### 9. Add deterministic focused server tests

In `packages/music-core/tests/session-server.test.ts`:

1. Use unique real Unix paths and real `net.Socket`s for integration behavior. Clean paths in test finalizers without masking product cleanup failures.
2. Use Node event promises or Effect `Deferred`/`Latch`/`Queue` signals for connect, replay, accepted/enrolled/finalized, command-start, and close events. Do not use `setTimeout`, arbitrary sleeps, `Date.now()` for uniqueness, or repeated `Effect.yieldNow` as synchronization evidence.
3. Prefer the approved Effect-native provider fixture and direct Layer composition for scoped-lifecycle tests. Keep `startMusicSessionServer` coverage to prove the public facade.
4. Instrument exact listener/fiber/source counts through the narrow server/provider test hooks. Do not treat `socket.destroyed` alone as proof all child fibers finalized.
5. Ensure every test closes its scope/socket even when an assertion fails.

The focused suite must prove all of the following without requiring Phase 4 behavior:

#### Layer and foreground behavior

- Building one graph acquires exactly one provider Layer/source subscription, one coordinator, and one Unix listener.
- Two current explicit clients each receive hello success plus immediate status/state replay.
- A complete provider snapshot is broadcast to both clients.
- Commands from both clients enter the one coordinator FIFO in observed order.
- One client disconnect does not stop replay/updates/commands for the other.

#### Connection ownership

- Closing with a connected pre-hello socket destroys it and finalizes its connection scope exactly once.
- Closing with a socket that sent a partial frame finalizes input/framer/listeners without leaking work.
- Natural pre-hello and post-hello disconnects finalize their own scopes while the listener remains healthy.
- Closing a post-hello connection finalizes status/state forwarding fibers before a late provider event; no late write is attempted.
- Closing while a socket command is blocked interrupts its waiting connection work, releases all server children, and produces no late response after provider release.
- Closing while coordinator sampling is blocked returns after scope interruption and finalizes provider/listener/socket ownership exactly once.
- Acceptance racing shutdown either enrolls-and-finalizes or immediately destroys the socket; no accepted socket is orphaned.

#### Error and idempotency behavior

- Binding a second server to an occupied socket returns tagged `listen` failure and neither closes nor unlinks the healthy first server’s path.
- Injected server-close failure returns tagged `close` failure while connection cleanup, unlink attempt, and provider finalization still occur.
- Injected non-`ENOENT` unlink failure returns tagged `unlink` failure after listener/connection/provider cleanup.
- `ENOENT` unlink is tolerated.
- Calling `close()` repeatedly reuses one cleanup run/outcome; counters for close, unlink, connection finalization, provider subscription, and provider finalization remain one.
- A connection-level parse/socket failure closes only that client; a healthy peer and listener continue.

#### Executable ownership seam

- The signal-wait helper removes both registered handlers on completion and interruption, using an injected/test EventEmitter seam if needed.
- Static/runtime test evidence confirms the executable composes the Layer graph directly and never calls the Promise server facade.

Do not add compatibility-range, malformed nested schema, reconnect, default socket, idle-exit, 24-client, or slow-reader tests here.

## Acceptance checks

All checks below must pass before handing off Phase 3:

- One production Layer graph owns exactly one provider, provider event source, coordinator, and Unix listener.
- Every accepted socket is immediately supervised or destroyed; pre-hello and mid-frame sockets cannot outlive the server scope.
- Node listener callbacks, input processing, current request handling, status/state forwarders, and blocked command waits are children of the correct connection scope.
- Natural disconnect finalizes only that connection; listener and healthy peers remain live.
- Server closure interrupts/awaits every connection and forwarding fiber, closes the listener, unlinks only its successfully bound path, and then releases coordinator/provider resources exactly once.
- Current explicit hello/replay/state/transport behavior remains green for two clients without protocol/client edits.
- Listen, close, and non-`ENOENT` unlink failures retain `MusicSessionSocketError` operation/cause, continue remaining cleanup, and reach the Layer/Promise/process boundary.
- Repeated close is idempotent and never repeats cleanup, including after a reported cleanup failure.
- The executable runs the Layer graph directly; signal handlers are scoped and removed.
- No detached Promise loop, raw timer, isolated `Effect.runSync`, or untracked runtime call owns server/connection work.
- Approved Phase 1 provider and Phase 2 coordinator focused suites remain green.
- Product/test changes are confined to the allowed Phase 3 files, apart from this run’s `.apnea` artifacts. Unrelated dirty changes and `.apnea/state.json` remain untouched.

## Verify commands

Run from the repository root in this order:

```sh
bun test packages/music-core/tests/session-server.test.ts
bun test packages/music-core/tests/session-coordinator.test.ts packages/music-core/tests/system-media.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n "Effect\.runSync|setTimeout\(|setInterval\(" packages/music-core/session/coordinator.ts packages/music-core/session/provider.ts packages/music-core/session/server.ts
! rg -n "startMusicSessionServer" packages/music-core/session/music-sessiond.ts
! rg -n "Effect\.repeat\(Effect\.yieldNow|setTimeout\(|new Promise\(.*setTimeout|Date\.now\(" packages/music-core/tests/session-server.test.ts
jj diff --summary
```

The Promise scan intentionally permits event-to-Promise adapters for real Node socket events. The runtime scan permits `Effect.runPromise` only in `startMusicSessionServer`’s outer Promise facade and the executable’s single top-level process boundary; inspect any additional occurrence.

Inspect `jj diff --summary`; do not reset or clean the worktree. Keep implementation in the current Jujutsu phase child for review. Do not run `git commit`, push, or manually rewrite history. After approval, follow the run’s `jj squash` workflow to fold the accepted Phase 3 child into the accumulated run change before Phase 4 begins.

## Dependencies

- Approved Phase 1 provider service, shared bounded event source, tagged provider failures, and exact-once source finalization.
- Approved Phase 2 config/coordinator Layers, replayable `SubscriptionRef`s, bounded global FIFO, atomic authority, Effect-time scheduling, deterministic provider fixture, and closure semantics.
- Existing current protocol/framer/client behavior as an unchanged foreground compatibility fixture.
- macOS/Node Unix-domain socket support and pinned Effect v4.

## Non-goals

- New schemas, manual-validator removal, revision-range/capability negotiation, package-version skew policy, or new wire messages.
- Client generation filtering changes, reconnect, command indeterminacy refinement, or command replay policy changes.
- Runtime-directory/default socket selection, owner/permission/symlink checks, stale artifact recovery, startup marker, detached daemon auto-launch, or singleton races.
- Zero-client idle shutdown, process replacement, lifecycle diagnostics expansion, 24-client scale, complete inbound/outbound bounds, state coalescing for slow readers, or abuse isolation.
- Native artwork request/caching/deduplication.
- OpenCode or Pi migration and host behavior.
- Manifest, export, bin, pack verifier, packed-Node smoke, README, or architecture HTML changes.
- Publishing, committing, pushing, opening a PR, editing `.apnea/state.json`, or removing unrelated worktree content.
