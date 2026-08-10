---
status: done
---

# Music Player Synchronization Plan

## Goal

Refactor the shared system-media core and OpenCode music player on top of `fix/music-player-sync` so complete `media-control stream` snapshots update playback immediately and stream termination starts recovery immediately. Separate provider sampling, transport execution, artwork enrichment, and UI projection so delayed work in one lane cannot block another. Represent every accepted transport intent instead of dropping input behind a global busy latch. Scope playback clocks to backend instances, let artwork completion update matching presentation independently, and retain bounded polling only for recovery and polling-only providers. Preserve play, pause, seek, skip, artwork, Kitty rendering, Pi behavior, and justified package interfaces. Add deterministic regressions for app-originated pause, stream termination, delayed refresh with repeated controls, and lifecycle cleanup. Deliver reviewable tracer phases without modifying PR #40.

## Architecture Constraints

- Normalize explicit `player()` results and complete stream payloads through one media-sample decoder.
- Extend the optional `MusicBackend.subscribe` listener additively with a discriminated authoritative-snapshot or invalidation event. Existing no-argument listeners may ignore the argument.
- Apply a valid stream snapshot at arrival. Do not wait for `player()`, artwork, command settling, or polling.
- Emit one immediate invalidation when a stream generation terminates, then retain capped stream-restart backoff and one bounded recovery poll.
- Give provider sampling, ordered transport execution, keyed artwork work, and synchronous UI projection independent concurrency lanes.
- Use sequence, transport-revision, lifecycle-generation, and track-identity checks only to reject stale asynchronous work. Never reject a newer authoritative snapshot.
- Give every `createSystemMedia()` backend its own playback clock. Keep stateless helpers public where justified and document any explicit clock argument changes.
- Keep `nowplaying-cli` polling-only.
- Preserve existing `Promise<void>` transport interfaces and handled-error behavior. A live command resolves after backend success or after its failure has been converted into the existing UI error state and toast. Coalesced seek callers resolve together when the surviving command attempt settles. Disposal resolves accepted but unfinished command promises as canceled no-ops, including the caller waiting on an in-flight backend operation; the detached backend operation may finish but its result or handled error cannot project state, show a toast, enqueue refresh work, or reject a caller. Invalid, unsupported, and post-disposal intents keep resolving immediately without enqueueing.

## Phases

### Phase 1: Backend-Scoped Clock And Authoritative Core Events

**Intent**

Deliver a host-consumable core contract. Streaming backends emit normalized snapshots and terminal invalidations immediately, while each backend owns all playback-clock state.

**Likely files touched**

- `packages/music-core/clock.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/types.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/tests/clock.test.ts`
- `packages/music-core/README.md`

**Steps**

1. Replace the module-global clock with an explicit clock instance or closure owned by each `createSystemMedia()` result.
2. Route sample normalization and idle, play, pause, seek, next, and previous clock mutations through that backend-owned clock.
3. Extract one decoder for `media-control get` output and complete stream envelope payloads, including one arrival timestamp used for reconciliation.
4. Add a discriminated subscription event for an authoritative normalized snapshot and for an invalidation with a stream-termination reason.
5. Emit valid stream snapshots directly. Ignore malformed or non-data envelopes without preventing later valid events.
6. Deduplicate error, exit, and close notifications from one stream generation into one immediate terminal invalidation. Preserve capped 1/2/4/8-second restart backoff and reset it after valid data.
7. Make subscription disposal idempotently stop the process, cancel retry timers, and suppress late callbacks.
8. Update public exports and documentation for event-bearing subscriptions, explicit clock ownership, polling-only providers, and disposal.

**Acceptance checks**

- A complete stream payload with `playing: false` emits an authoritative paused `PlayerState` without invoking `player()`.
- Two backend instances can sample and control different tracks without changing each other's clock, position, or play state.
- Error, exit, and close from one stream generation produce exactly one immediate invalidation.
- Stream restart remains capped at 1/2/4/8 seconds and resets after a valid snapshot.
- `nowplaying-cli` still omits `subscribe` and returns normalized polled state.
- Disposal kills the active stream, cancels retry work, and suppresses late snapshots and invalidations.

**Verify commands**

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core
```

**Dependencies**

- None.

**Non-goals**

- Host controller scheduling.
- Artwork fetching or rendering.
- Stream support for `nowplaying-cli`.

### Phase 2: End-To-End Independent Artwork Projection

**Intent**

Remove artwork latency from playback delivery and complete the full producer-to-controller artwork path in one green slice. Matching artwork completion updates OpenCode presentation without another provider sample or stream event.

**Likely files touched**

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/types.test.ts`
- `packages/opencode-music-player/tests/artwork.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`

**Steps**

1. Return or forward normalized playback state without awaiting native artwork sampling, catalog lookup, download, conversion, or retry delay.
2. Forward core snapshot and invalidation events while preserving the core disposer exactly once.
3. Start at most one artwork job per complete artwork cache identity. Keep loading state in presentation without blocking snapshots or explicit `player()` calls.
4. Add a host-specific presentation-event seam, separate from core snapshot and invalidation events, and publish artwork completion with the complete artwork identity, resolved artwork, and associated duration metadata.
5. Consume that presentation event in the OpenCode controller in this phase. Merge it synchronously only when the current track still matches the complete identity and the controller remains live.
6. Ignore late artwork for replaced tracks and disposed controllers. Do not copy playback fields from artwork completion into current state.
7. Preserve cache bounds, retry limits and backoff, native identity validation, matching artwork across volatile provider IDs, and the existing Kitty-facing `Artwork` shape.
8. Add an end-to-end controller regression that leaves artwork unresolved, applies a playback update, resolves artwork, and observes matching session presentation without another provider call or event.

**Acceptance checks**

- A paused or changed playback snapshot reaches `session.player` while an earlier artwork promise remains unresolved.
- Resolving artwork updates the matching session presentation without another `player()` call, stream event, or poll.
- Late artwork for track A cannot decorate track B or overwrite B's playback fields.
- Concurrent requests for one complete artwork identity share one job and preserve existing cache and retry bounds.
- Failed artwork resolution neither sets a playback error nor delays transport state.
- Existing artwork selection, conversion, and Kitty rendering contracts remain unchanged.

**Verify commands**

```sh
bunx nx run-many -t typecheck test format:check --projects=opencode-music-player
```

**Dependencies**

- Phase 1 subscription events and normalized snapshots.

**Non-goals**

- Transport queue replacement.
- Kitty placement, terminal escape sequence, catalog matching, image-limit, or layout changes.

### Phase 3: OpenCode Sampling And Transport Lanes

**Intent**

Replace OpenCode's global busy and seek-drop behavior with explicit lanes. Retain repeated controls while provider work is delayed, project authoritative snapshots immediately, and make command and disposal outcomes deterministic.

**Likely files touched**

- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/package-load.test.ts` only if an existing test seam changes

**Steps**

1. Replace the global loading exclusion and seek latch with an ordered queue of explicit play, pause, seek, next, and previous intents.
2. Capture toggle intent at enqueue time from projected state plus preceding queued intent, so repeated toggles alternate deterministically. Preserve every discrete toggle and skip command.
3. Coalesce only adjacent, not-yet-started seeks. Execute the latest target once and resolve every superseded seek caller when that retained command attempt settles.
4. Serialize backend commands in accepted order. After command success, project optimistic play/pause or seek state, then request reconciliation without retaining the command lane through provider delay.
5. Keep provider sampling in a separate single-flight, coalescing lane. Reject stale poll results using request sequence and transport revision, while always applying a newer authoritative stream snapshot synchronously.
6. Handle terminal invalidation by requesting a sample immediately. Maintain exactly one state-based 3/5/8-second poll deadline after sampling settles for stream recovery and polling-only backends.
7. Derive loading from pending command count rather than using it as a lock. Scope backend failures and toasts to the failed live command.
8. Implement the documented promise contract: success resolves, a live backend failure updates the existing error UI and then resolves, coalesced seek callers resolve when the retained attempt settles, and disposal resolves queued and caller-visible in-flight promises as canceled no-ops. Invalid and unsupported intents continue to resolve immediately.
9. On disposal, unsubscribe once, clear the sole poll, reject no callers, accept no new work, execute no queued commands, and detach in-flight sample, command, and artwork completions from projection, toast, and follow-up scheduling.

**Acceptance checks**

- An app-originated paused stream snapshot changes `session.player.is_playing` before a held refresh resolves.
- Stream termination requests one provider sample immediately and leaves one bounded recovery poll after sampling settles.
- With `player()` held unresolved, repeated toggles and skip inputs execute later in captured order rather than disappearing.
- A delayed pre-transport poll cannot undo successful optimistic state, while a newer authoritative stream snapshot can correct it.
- Adjacent pending seeks execute only the newest target, and all associated promises resolve when that attempt settles.
- A live backend command failure resolves its caller after producing only the existing error presentation; discarded UI promises cannot create unhandled rejections.
- Disposal resolves queued and caller-visible in-flight command promises, executes no queued backend commands, and permits no late mutation, toast, timer, follow-up sample, or unhandled rejection.
- Calls after disposal resolve without invoking the backend.
- Existing controller methods and Compact/Sidebar transport callback signatures remain unchanged.

**Verify commands**

```sh
bunx nx run-many -t typecheck test format:check package:check smoke --projects=opencode-music-player
```

**Dependencies**

- Phase 1 core event semantics.
- Phase 2 independent artwork projection.

**Non-goals**

- Parallel transport execution against one backend.
- UI redesign, keybinding changes, or storage migration.
- Removing optimistic feedback or provider-specific settling delays that remain necessary.

### Phase 4: Pi Event Adoption And Explicit Transport Queue

**Intent**

Adopt authoritative core events in Pi and replace Pi's global busy-drop behavior with a definite ordered command lane. Preserve its user-visible status, controls, and lifecycle while proving both hosts and published packages work together.

**Likely files touched**

- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/test/index.test.ts`
- `packages/music-core/README.md`
- `packages/opencode-music-player/README.md`
- `packages/pi-music-dock/README.md`

**Steps**

1. Consume authoritative snapshot events directly in Pi and map terminal invalidations to an immediate sample request.
2. Keep Pi provider sampling single-flight and separate from transport execution. Retain one 3/5/8-second state-based poll for stream recovery and as the primary mechanism when `subscribe` is absent.
3. Remove Pi's global busy guard as an input filter. Queue every accepted toggle, next, and previous intent in invocation order, capture toggle targets at enqueue time, and serialize backend calls without waiting for provider refresh.
4. Preserve Pi's current command and shortcut return contracts. On reload or shutdown, stop dequeuing, clear pending intents as canceled no-ops, and detach in-flight backend completion from status, notification, and refresh work.
5. Protect direct snapshots from stale in-flight samples with request, transport, and lifecycle generations.
6. Add a deterministic regression that holds provider refresh unresolved, invokes repeated Pi controls, and proves all backend commands execute once in captured order.
7. Add reload and shutdown coverage for the subscription, poll timeout, waveform interval, pending sample, queued command, and in-flight command completion.
8. Preserve status text, waveform behavior, shortcuts, slash-command names, notifications, reload flow, session shutdown, and polling-only operation.
9. Update runtime documentation and run packed-package checks to detect missing exports, accidental Bun dependencies in `music-core`, or changed OpenCode/Pi entry points.

**Acceptance checks**

- Pi renders a stream-originated pause or track change before the next poll.
- Pi remains functional with a backend that omits `subscribe`.
- During a held refresh, repeated Pi toggle and skip inputs all execute once in captured order; none are silently dropped.
- A stale Pi sample cannot overwrite a newer transport result or authoritative stream snapshot.
- Reload disposes the old subscription, poll, waveform interval, pending host generation, and command queue before replacement setup.
- Shutdown clears status and suppresses all late sample, command, stream, and timer effects.
- Existing Pi status rendering, commands, shortcuts, and notifications remain unchanged.
- Core, OpenCode, and Pi package checks and smoke consumers pass together.

**Verify commands**

```sh
bunx nx run-many -t typecheck test format:check package:check smoke --projects=pi-music-dock
bunx nx run-many -t typecheck test format:check package:check -p music-core opencode-music-player pi-music-dock
bunx nx run-many -t smoke -p opencode-music-player pi-music-dock
bun run check
```

**Dependencies**

- Phases 1 through 3.

**Non-goals**

- Pi visual redesign or new controls.
- Modifying, force-pushing, or adding commits to PR #40.
- Release, version, or changelog publication.

## Definition Of Done

- Valid stream snapshots and explicit samples share normalization and backend-scoped clock state, and snapshots update OpenCode and Pi immediately.
- A deterministic app-originated pause regression passes without resolving fallback refresh work.
- Stream termination emits one immediate recovery request, restarts with bounded backoff, and leaks no callback after disposal.
- Provider sampling, ordered commands, artwork jobs, and UI projection do not share a global exclusion latch.
- OpenCode and Pi retain every discrete transport intent during delayed sampling; documented seek coalescing settles every caller through the retained command.
- Live command success and handled failure, seek supersession, invalid input, disposal cancellation, and post-disposal calls follow the documented resolving `Promise<void>` contract.
- Each system-media backend owns isolated clock state; no module-global playback clock remains.
- Artwork completion independently updates only the matching presentation without another sample and preserves existing Kitty behavior.
- Streaming providers retain one bounded recovery poll. `nowplaying-cli` remains polling-only with state-based 3/5/8-second bounds.
- OpenCode and Pi lifecycle tests cover subscription, timer, in-flight sample, in-flight command, artwork, queued intent, reload, and disposal cleanup.
- Existing OpenCode controller entry points, Pi commands and shortcuts, justified `MusicBackend` consumers, package exports, archives, and smoke installations pass.
- Every phase verification command and `bun run check` pass on the new stack based on `fix/music-player-sync`, with PR #40 unchanged.
