---
status: done
---

# Phase 8 package: introduce a tested OpenCode session adapter

## Intent

Add a lightweight OpenCode-facing adapter over the public reconnecting music-session client, plus a deterministic fake seam that drives the existing controller contracts.

The adapter must project replay/live state and provider/connection lifecycle into the existing OpenCode player model, delegate controls once, retain state across reconnect generations, and obtain native artwork only through `client.artwork(identity)`. OpenCode's catalog fallback, image conversion, presentation cache/jobs, accent/cell generation, Kitty/half-block rendering, and completion events stay host-local.

Keep production selection unchanged in this phase: `controllerDependencies.createBackend` must still select the existing direct `createSystemMedia`. Phase 9 performs the production cutover and removes duplicate polling/provider ownership. This phase leaves a green, fully tested adapter that can be selected in one later tactical change.

Use no real daemon in adapter/controller tests. A deterministic fake reconnecting client must control replay, live status/state, lifecycle generations, commands, artwork outcomes, and disposal.

## Files to touch

Only as required:

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/artwork-lifecycle.test.ts`

Do not create a new source or test module. Keep the direct and session adapters in the existing system-media facade for this phase.

## Files not to touch

- Anything under `packages/music-core/`
- Anything under `packages/pi-music-dock/`
- `packages/opencode-music-player/ui.tsx`
- `packages/opencode-music-player/artwork.ts`
- `packages/opencode-music-player/artwork.tsx`
- `packages/opencode-music-player/kitty-graphics.ts`
- `packages/opencode-music-player/artwork-placement.ts`
- `packages/opencode-music-player/tmux-offset.ts`
- `packages/opencode-music-player/package.json`
- `packages/opencode-music-player/project.json`
- `bun.lock`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

If a host presentation helper must be reused, import its existing API; do not move or rewrite it in this phase.

## Exact implementation steps

### 1. Preserve the approved core and direct backend baseline

1. Treat approved Phase 1–7 changes, especially `createReconnectingMusicSessionClient`, `ArtworkIdentity`, `ArtworkResult`, generation fencing, bounded fan-out, and scoped artwork cache, as fixed dependencies.
2. Preserve all existing direct `createSystemMedia` behavior and tests. It remains the production backend selected by `controllerDependencies` until Phase 9.
3. Preserve OpenCode controls, shortcuts, UI state shape, optimistic transport/seek projection, local intent coalescing, artwork rendering, and native image ownership.

### 2. Define a narrow session-client factory seam

In `packages/opencode-music-player/system-media.ts`:

1. Import only the public host-neutral core surface from `@naxodev/music-core`: reconnecting client constructor/types, state/status/lifecycle types, artwork identity/result, and baseline capabilities as needed.
2. Add a factory type equivalent to `() => Promise<ReconnectingMusicSessionClient>`. Production default creates exactly one reconnecting client with a unique/stable OpenCode client ID, `hostKind: "opencode"`, and capabilities including state replay, transport, and native artwork.
3. Add a session-adapter override type for tests containing only:
   - client factory;
   - existing artwork resolver seam;
   - deterministic `now` if required by host artwork retry/cache behavior.
4. Do not expose core test dependencies, marker/runtime paths, provider/server Layers, launchers, or Effect scopes through the OpenCode adapter API.
5. Invoke the client factory at most once per adapter instance. Store the one pending Promise so concurrent `player`, subscribe, control, and artwork work share it.

### 3. Make the OpenCode backend explicitly disposable

In `packages/opencode-music-player/types.ts`:

1. Add an optional host-backend `dispose` operation that may complete asynchronously. Existing direct/fake backends remain source-compatible.
2. Extend host-local change events only as needed to represent provider status and connection lifecycle through the existing controller subscription contract. Do not change core wire types.
3. Keep `PlayerState` presentation extensions (`artwork`, `artwork_loading`) host-local.

In `index.tsx`:

1. During controller disposal, mark the controller dead/increment its generation before unsubscribing or invoking backend disposal.
2. Invoke `backend.dispose?.()` once after listener teardown; safely observe/reject its Promise so disposal cannot create an unhandled rejection.
3. Preserve synchronous/idempotent `Controller.dispose()` and all existing caller settlement/loading behavior.

### 4. Project session state without recreating provider authority

Add a separate exported factory with clear naming, such as `createSessionSystemMedia`, while retaining existing `createSystemMedia`.

The session adapter must:

1. Implement the existing host `MusicBackend` surface without calling core `createSystemMedia`.
2. Keep the latest core `RevisionedState`, `ProviderStatus`, and connection lifecycle from the one reconnecting client.
3. `player()` waits for initial client acquisition if needed, then returns the latest projected retained state. It never invokes native sampling, provider probing, a playback clock, or a daemon state request loop.
4. Convert core state into OpenCode state by preserving playback/device/track fields and adding only host artwork/loading presentation fields.
5. Subscribe once to client state, status, and connection lifecycle. State replay from the client must immediately become a host snapshot; later snapshots remain authoritative even when a replacement daemon revision is numerically lower.
6. During reconnect, retain/project the last state rather than clearing the player. Publish a bounded host lifecycle/invalidation signal so the controller can show actionable connection feedback without starting provider work.
7. On connected replacement, clear only connection-originated errors and accept the replacement replay. On terminal incompatibility/runtime/config errors, retain state and expose the structured message.
8. Isolate host listener exceptions and make every unsubscribe idempotent.

Do not create adapter polling, sampling lanes, retry schedules, playback clocks, or transport queues. Existing controller polling remains baseline because production is not cut over; when exercised against this adapter it may read cached `player()` only.

### 5. Delegate controls once and preserve controller semantics

1. Implement `play`, `pause`, `next`, `previous`, and `seek` by awaiting the one client and invoking the corresponding method exactly once.
2. Do not optimistically mutate adapter state; the existing controller's optimistic state/loading/toast logic remains the owner until daemon replay/live state arrives.
3. Do not add a general command queue. The existing controller intent lane continues to coalesce local seeks and serialize UI calls in tests; the core client/global daemon lane owns actual command admission.
4. During reconnect/terminal/disposal, pass through stable core errors so controller error/toast behavior can be verified.
5. A command completion after adapter/controller disposal must not mutate state, toast, schedule reconciliation, or start another command.

### 6. Route only native artwork through the session

Refactor the existing host artwork projection just enough that direct and session backends can supply different native callbacks while sharing host-local resolution/presentation behavior.

1. For a session track, map complete core track identity to Phase 7 `ArtworkIdentity` exactly (`id`, name, artists, album, duration).
2. The session native callback invokes `client.artwork(identity)` once on the active generation.
3. Map `available` to its bounded base64 string for `resolveArtworkDetails`.
4. Map `unavailable`, `stale`, and `too-large` to no native bytes so existing host-local catalog fallback may run.
5. Treat request failure/disconnect as transient host artwork failure according to the existing bounded retry behavior; never issue `media-control`, replay the request, or cache an error as artwork.
6. Preserve OpenCode's current metadata-based artwork cache key and full provider-ID identity used for stale completion checks.
7. Preserve local iTunes lookup, HTTP fetch, conversion, accent/cells, cache/jobs, presentation completion, and merge guards unchanged.
8. Adapter/controller disposal must suppress late native result, resolver completion, and presentation publication. It must not remove another controller generation's native image ownership.

### 7. Implement a deterministic fake reconnecting client in existing tests

In `tests/system-media.test.ts` or `tests/controller.test.ts`, add a local fake implementing only the public reconnecting client contract.

It must provide deterministic controls for:

1. Initial Promise acquisition success/failure and late completion after adapter disposal.
2. Replay and later state/status emissions.
3. Connection lifecycle transitions: connected A, reconnecting, connected B, terminal, disposed.
4. Distinct daemon instance IDs and lower replacement revisions.
5. Command calls/results/failures, including held completion.
6. Artwork calls/results/failures, including late A completion after B/disposal.
7. State/status/connection subscription counts and exact-once unsubscription.
8. Async idempotent disposal count/completion.

Do not fake through private core fields or import core test seams. The fake must demonstrate that the adapter depends only on the public package contract.

### 8. Add adapter-focused system-media tests

In `packages/opencode-music-player/tests/system-media.test.ts`:

1. Assert twenty concurrent/serial adapter operations still invoke the client factory once.
2. Assert initial replay and live state project to OpenCode `PlayerState` without calling direct core sampling or `media-control`.
3. Drive provider ready/degraded/unavailable status and connection A → reconnecting → B → terminal transitions; assert retained state and stable host events/messages.
4. Assert replacement B replay is accepted with a lower revision and new daemon ID.
5. Assert every control delegates once with exact seek position and no adapter queue/replay.
6. Assert native artwork requests use complete identity and never invoke host `run(["media-control", ...])`.
7. Cover available, unavailable, stale, too-large, rejected, disconnected, and disposed artwork outcomes while preserving catalog fallback/resolver arguments.
8. Assert stale/late artwork for an old identity/generation cannot publish onto the current track.
9. Assert unsubscribe/dispose clears all client listeners and a client resolving after disposal is immediately disposed without callbacks.
10. Keep all Deferreds/fake listeners settled in `finally` so failed assertions cannot leak Promise work.

### 9. Prove the existing controller contract with the adapter fake

In `controller.test.ts`:

1. Inject `createSessionSystemMedia` backed by the deterministic fake through the existing `createBackend` dependency; do not change production selection.
2. Prove initial replay, live playing/paused/idle state, replacement replay, reconnect, and terminal feedback update the existing session store correctly.
3. Preserve loading semantics for successful and failed controls.
4. Preserve command feedback/toasts and optimistic play/pause/seek behavior until authoritative state arrives.
5. Preserve local seek coalescing: multiple UI seeks may coalesce in the controller, and the adapter sends only the controller's resulting calls without adding another queue.
6. Preserve waveform-compatible playback fields (`progress_ms`, `fetched_at`, `is_playing`, duration) across replay/reconnect.
7. Prove native artwork completion merges only when full host identity still matches and leaves current playback state authoritative.
8. Listener exceptions from one observer must not block controller updates.

Do not redesign store keys, controls, shortcuts, UI components, or toast text beyond the minimum lifecycle mapping.

### 10. Prove disposal and late-work suppression

In `controller-lifecycle.test.ts`:

1. Dispose before the client factory resolves; when the fake client later arrives, assert it is disposed once and no subscription/state/toast/timer work starts.
2. Dispose with active subscriptions and assert state/status/connection/presentation listeners each unsubscribe once before client disposal.
3. Resolve held state, status, command, reconnect, and artwork callbacks after disposal; assert no store mutation, toast, poll/reconciliation timer, next command, or presentation completion.
4. Call controller/backend disposal repeatedly and assert exact-once client disposal and caller settlement.
5. Preserve all existing direct-backend lifecycle tests.

In `artwork-lifecycle.test.ts`, add only the adapter-specific ownership assertion needed to prove a late session artwork completion cannot clean up or overwrite a newer presentation owner. Keep Kitty/image cleanup implementation unchanged.

### 11. Keep production selection unchanged and make that explicit

1. Leave `controllerDependencies.createBackend: createSystemMedia` unchanged.
2. Do not call `createSessionSystemMedia` from default plugin startup, `createController`, `AppHost`, or sidebar registration in this phase.
3. Add a focused assertion/static inspection showing adapter tests opt in through dependency injection and the real default remains direct.
4. Loading the production plugin must therefore retain its current behavior until Phase 9.

### 12. Keep Phase 8 isolated

1. Do not delete direct provider/poll/sample/clock/transport code yet.
2. Do not change package manifests, public files lists, or lockfile.
3. Do not migrate Pi.
4. Do not run packed/live host smokes or edit docs.
5. Format only touched files and inspect the exact diff.
6. Keep work in the current reviewed Jujutsu phase child. Do not run `git commit`, `jj commit`, `jj squash`, push, or open a PR. After approval, the orchestrator may squash only this reviewed phase through the prescribed workflow.

## Acceptance checks

Phase 8 is complete only when:

- `createSessionSystemMedia` owns exactly one public reconnecting client and has a deterministic public-contract fake seam.
- Replay/live state/status, A → reconnecting → B, terminal errors, controls, disposal, and native artwork outcomes flow through existing OpenCode backend/controller contracts without a real daemon.
- The adapter owns no provider/probe/stream/poll/sample lane/playback clock/general command queue and never executes `media-control` directly.
- State remains presentation-stable during reconnect and lower-revision B replay is accepted by generation.
- Commands delegate once, controller loading/toasts/optimistic projection/seek coalescing remain green, and no command/artwork request is replayed.
- Native bytes come only from `client.artwork`; catalog lookup, conversion, presentation caches/jobs, rendering, and completion events remain host-local and identity-safe.
- Disposal is idempotent, closes a late or active client exactly once, unsubscribes all listeners, and suppresses late state/status/command/artwork/reconnect work.
- Production default selection remains the direct `createSystemMedia`; no obsolete code is deleted yet.
- Core, Pi, manifests, package metadata, docs, and unrelated worktree content remain untouched.

## Verify commands

Run from the repository root:

```sh
bun test --preload @opentui/solid/preload packages/opencode-music-player/tests/system-media.test.ts packages/opencode-music-player/tests/controller.test.ts packages/opencode-music-player/tests/controller-lifecycle.test.ts packages/opencode-music-player/tests/artwork-lifecycle.test.ts
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
jj diff --summary
```

Inspect the exact phase diff and production selector:

```sh
jj diff --git packages/opencode-music-player/system-media.ts packages/opencode-music-player/types.ts packages/opencode-music-player/index.tsx packages/opencode-music-player/tests/system-media.test.ts packages/opencode-music-player/tests/controller.test.ts packages/opencode-music-player/tests/controller-lifecycle.test.ts packages/opencode-music-player/tests/artwork-lifecycle.test.ts
git diff --check
rg -n 'createBackend: createSystemMedia|createSessionSystemMedia|media-control.*get.*--now' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
```

Confirm manually:

- default controller selection still names direct `createSystemMedia`;
- session adapter client creation is one-shot and public-contract-only;
- session adapter contains no provider detection, native process execution, polling timer, playback clock, or command queue;
- only the direct legacy backend retains `media-control get --now` until Phase 9 cutover;
- session native artwork calls `client.artwork` and all presentation work remains host-local;
- no core/Pi/manifest/lock/docs file changed;
- `.apnea/state.json` and unrelated dirty paths were not altered.

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Approved Phase 1 (`08acaab5`), Phase 2 (`73a988d6`), Phase 3 (`788473b7`), Phase 4 (`b376a94d`), Phase 5 (`82853612`), Phase 6 (`caf926c9`), and Phase 7 (`a234f763`) changes.
- Public core `createReconnectingMusicSessionClient`, reconnect lifecycle/state/status subscriptions, transport methods, `ArtworkIdentity`, and bounded artwork result.
- Existing OpenCode `MusicBackend`, controller dependency injection, presentation merge, resolver/cache, and lifecycle tests.

## Non-goals

- Selecting the session adapter in production, deleting the direct backend, removing controller polls/sample lanes/playback clocks/transport queues, or proving real daemon integration in OpenCode.
- Pi migration, Pi artwork/seek, UI redesign, shortcut/control changes, store-key changes, package manifests, lockfile, packed smokes, READMEs, or architecture HTML.
- Moving iTunes/catalog/download/conversion/rendering into core, adding artwork to player replay, remote sockets, or durable host state.
- New source/test modules, unrelated cleanup, commits or squashing during coding, pushing, publishing, opening a PR, or editing `.apnea/state.json`.
