---
status: done
---

# Phase 3: OpenCode Sampling And Transport Lanes

## Intent

Replace the OpenCode controller's global loading exclusion and seek latch with independent sampling and ordered transport lanes. Provider delay must not discard accepted controls, block authoritative snapshots, or hold the command lane after a backend command settles.

This phase owns OpenCode controller scheduling, command promise semantics, and lifecycle cleanup. It preserves the phase 2 artwork lane and existing UI and package interfaces. Pi adopts the same architecture separately in phase 4.

## Dependencies

- Phase 1 authoritative snapshot and stream-termination invalidation events must be present.
- Phase 2 independent artwork presentation events and disposal must be present.
- Work on top of the approved phase 2 result based on `fix/music-player-sync` without modifying PR #40.

## Files To Touch

- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts` if separating lifecycle cases keeps the existing controller test readable

Keep queue and lane types private to `index.tsx`. Do not change a public type or export only to make tests easier.

## Files Not To Touch

- `packages/music-core/**`
- `packages/pi-music-dock/**`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/artwork.ts`
- `packages/opencode-music-player/artwork.tsx`
- `packages/opencode-music-player/kitty-graphics.ts`
- `packages/opencode-music-player/ui.tsx`
- `packages/opencode-music-player/tests/system-media.test.ts` unless a regression proves the already-approved facade contract is broken
- `packages/opencode-music-player/tests/package-load.test.ts` unless preserving an existing package-load seam requires an assertion update
- Other package source, tests, and documentation
- Package versions, changelogs, lockfiles, release metadata, storage keys, and CI configuration
- `.apnea/state.json`
- PR #40 or its branch history

## Required Contract

1. Keep the existing controller methods, `Promise<void>` transport signatures, Compact and Sidebar callbacks, plugin setup, and package exports unchanged.
2. Treat sampling, transport execution, artwork enrichment, and synchronous session projection as independent lanes. No shared `loading` or busy flag may exclude work in another lane.
3. Represent each accepted toggle, next, previous, and valid seek as a queued intent. Invalid, unsupported, and post-disposal calls resolve immediately without invoking the backend or entering the queue.
4. Capture a toggle as an explicit play or pause target when it is accepted. Use the latest preceding accepted play/pause target, including an in-flight or queued target, before falling back to the currently projected playback state. Later provider results must not reinterpret the captured intent.
5. Preserve every discrete play, pause, next, and previous intent in accepted order. Do not coalesce toggles or skip commands.
6. Coalesce only adjacent seek intents that have not started. Keep the newest target and settle every superseded seek caller when the retained backend attempt settles or when disposal cancels it. A non-seek intent breaks seek adjacency.
7. Run at most one backend transport command at a time. A command may start while `player()` sampling or artwork work remains unresolved.
8. After live backend success, synchronously project the corresponding optimistic play, pause, or seek result and advance a transport revision. Next and previous may retain existing transition feedback. Then request reconciliation without awaiting provider sampling before releasing the command lane.
9. A live command promise resolves after backend success, or after backend failure has been converted into the existing error presentation and toast. Backend failures must not reject controller promises or UI-discarded promises.
10. Derive `session.loading` from the count of accepted, unfinished command callers or intents. It is presentation state, not an admission lock. Coalesced seek callers must not leave loading stuck.
11. Keep provider sampling single-flight and coalescing. Multiple requests during one sample require at most one follow-up sample, and no request may run concurrently with another sample.
12. Capture a request sequence, current transport revision, and lifecycle generation for each sample. A sample may project only if the controller remains live, it is still the applicable request, and no newer accepted transport result makes it stale.
13. Apply every valid authoritative snapshot synchronously at callback arrival while live. Do not await or call `player()`, wait for a command, or reject the snapshot because of an older sample sequence or transport revision. Preserve the facade's artwork projection on that state.
14. Treat stream invalidation as an immediate sample request. Coalesce it with an in-flight sample rather than creating concurrent provider calls.
15. Maintain at most one controller poll timeout. After sampling settles, schedule one state-based recovery deadline using the existing 3/5/8-second policy. This remains the primary update path when `subscribe` is absent and bounded recovery when streaming is available.
16. Keep phase 2 artwork events independent. Matching completion may update only artwork presentation and missing duration. It must not enter the sample or command lanes, alter loading, or change poll scheduling.
17. Disposal must be idempotent. It unsubscribes core and artwork listeners once, clears the sole poll once, marks the lifecycle dead before releasing resources, and prevents new work.
18. Disposal resolves queued and caller-visible in-flight command promises as canceled no-ops immediately. It starts no queued backend command after disposal.
19. The detached in-flight backend operation and every in-flight sample must have rejection handling attached. Their late success or failure cannot mutate session state, show a toast, schedule a timer, enqueue a sample, start another command, or reject a caller.

## Implementation Steps

1. Replace controller-wide exclusion state in `packages/opencode-music-player/index.tsx` with explicit lane state.
   - Keep one lifecycle generation or equivalent live token checked by every asynchronous continuation.
   - Keep sampling state separate: active sample, one coalesced follow-up request, monotonically increasing request sequence, and one poll timeout.
   - Keep transport state separate: ordered pending intents, one active intent, transport revision, and waiter settlement for each accepted caller.
   - Keep the existing core and presentation subscription disposers separate.

2. Define a private discriminated transport-intent union.
   - Represent play, pause, seek, next, and previous explicitly.
   - Store seek targets in the backend's existing units and preserve current validation and clamping.
   - Store one or more resolve callbacks on an intent so coalesced callers share settlement without sharing uncaught rejection paths.
   - Do not expose the queue through the package API.

3. Route every transport method through one enqueue function.
   - Return an already-resolved promise for disposed, invalid, or unsupported operations.
   - For toggle, derive the explicit target from the last active or queued play/pause intent; use projected `session.player.is_playing` only when no preceding accepted target exists.
   - Append every play, pause, next, and previous intent.
   - If the queue tail is a not-yet-started seek, replace its target and append the new caller's resolver to that retained entry. Otherwise append a new seek entry.
   - Update loading presentation from pending accepted work and start the runner if idle.

4. Implement one non-reentrant transport runner.
   - Remove one intent from the head, mark it active, and invoke exactly one matching backend method.
   - Attach success and failure continuations immediately so ignored controller promises and backend rejection cannot become unhandled rejections.
   - Never hold this runner open for `player()`, artwork, poll delay, or provider-specific reconciliation delay.
   - After the active backend attempt settles, settle all of its callers once, clear it, update loading while live, and start the next intent in a later microtask or equivalent non-reentrant turn.

5. Preserve optimistic transport presentation without allowing stale polls to undo it.
   - On live play or pause success, update only the playback fields needed for immediate feedback and preserve current track and artwork presentation.
   - On live seek success, update progress and fetch timing with the existing seek semantics.
   - Preserve existing next and previous transition behavior and provider-specific settling delay where still needed, but schedule reconciliation outside the command lane.
   - Increment the transport revision when a successful command projects its result. A sample started against an older revision cannot overwrite it.
   - An authoritative snapshot received afterward remains authoritative and may correct optimistic state regardless of that revision.

6. Preserve handled command failures.
   - While live, map one failed backend attempt to the existing error player presentation and existing toast behavior once.
   - Resolve, never reject, every caller attached to the failed intent after error projection completes.
   - Continue with later queued intents; one failure must not poison or flush the queue.
   - If disposal occurred first, suppress error projection and toast and only consume the backend rejection.

7. Refactor refresh work into one single-flight sampling lane.
   - Make each refresh request either start a sample or mark one follow-up request while a sample is active.
   - Capture request sequence, transport revision, and lifecycle generation before calling `backend.player()`.
   - Apply successful state only when all captured guards remain current. Preserve existing state merge rules and error handling for an applicable live sample.
   - Consume stale success and failure without state mutation or toast.
   - On settlement, run at most one requested follow-up sample. Schedule polling only after the sampling lane becomes idle.

8. Centralize the sole poll deadline.
   - Clear the previous timeout before setting another.
   - Reuse the existing state-based 3/5/8-second delay selection rather than introducing a fixed fast loop.
   - A poll callback requests sampling through the same lane and cannot call `player()` directly.
   - Stream invalidation clears or supersedes the pending deadline and requests sampling immediately.
   - After the invalidation sample and any coalesced follow-up settle, leave exactly one bounded recovery timeout.
   - Continue scheduling for backends without `subscribe`; do not add stream support to a polling-only provider.

9. Keep subscription projection synchronous and lane-independent.
   - Subscribe before the initial sample, preserving phase 2 ordering.
   - For an authoritative snapshot, first check lifecycle, then assign its already-projected state immediately. Do not route it through refresh arbitration.
   - Reconcile any poll deadline from the new state without blocking the callback or creating a second timeout.
   - For invalidation or a legacy no-argument notification, request one immediate sample through the sampling lane.
   - Leave artwork completion handling on its separate matching-only path.

10. Make disposal settle ownership explicitly.
    - Mark the controller disposed and advance its lifecycle generation before unsubscribing or clearing resources.
    - Clear the poll and invoke both stored disposers at most once.
    - Resolve every queued intent's callers and remove the queue without invoking the backend.
    - Resolve the active intent's caller-facing promise immediately, while leaving a rejection handler attached to the already-started backend promise.
    - Clear pending sample requests and prevent active sample settlement from scheduling a follow-up or poll.
    - Calls made after disposal must resolve immediately and leave all backend call counts unchanged.

11. Add deterministic authoritative snapshot and recovery tests in `controller.test.ts`.
    - Hold the initial or fallback `player()` promise unresolved, emit an authoritative app-originated snapshot with `is_playing: false`, and assert `session.player` changes synchronously before the held sample settles.
    - Resolve the older held sample afterward and assert it cannot restore stale playback.
    - Emit stream termination, assert one immediate provider sample starts, keep it controlled with a deferred, then settle it and assert exactly one 3/5/8-second recovery timeout remains.
    - Advance fake time to the deadline and assert the timeout enters the same single-flight sample lane rather than creating parallel calls.

12. Add deterministic ordered transport tests.
    - Hold `player()` unresolved, invoke repeated toggles plus next and previous, and assert all backend commands execute once in captured order without waiting for the sample.
    - Prove repeated toggles alternate their captured play/pause targets even though projected provider state has not refreshed.
    - Hold the first backend command, enqueue adjacent seeks, and assert only the newest pending target executes. Assert every seek promise stays pending until that retained attempt settles, then resolves.
    - Insert a discrete intent between seeks and assert the two seek commands are not coalesced across it.
    - Start a sample before a successful command, project optimistic transport state, then settle the sample and assert it cannot undo that state. Emit a later authoritative snapshot and assert it can correct the state immediately.

13. Add deterministic failure and lifecycle tests.
    - Reject one live backend command and assert its caller resolves after exactly one existing error presentation and toast. Assert a later queued command still runs.
    - Invoke transport through the same fire-and-forget shape used by UI callbacks and prove no unhandled rejection is produced.
    - Dispose with one command in flight and more commands queued. Assert every returned promise resolves, no queued backend method runs, and repeated disposal is harmless.
    - Resolve and reject controlled command, sample, and artwork work after disposal. Assert no state mutation, toast, timer, follow-up sample, command start, or unhandled rejection.
    - Assert post-disposal refresh and transport calls resolve without backend work.
    - Assert core and presentation subscriptions each dispose exactly once and the one poll timeout is cleared.

14. Preserve existing behavior and test seams.
    - Keep current sample merge behavior, artwork identity matching, waveform-facing timestamps, error copy, toast copy, and state-based polling policy unless a required stale-work guard directly changes scheduling.
    - Keep Compact and Sidebar transport callbacks unchanged; they may continue to discard controller promises because those promises now always resolve.
    - Do not move controller internals into a public module merely for tests. Use the existing controller factory and injected backend, timer, and toast seams.
    - Update `package-load.test.ts` only if an unavoidable internal restructuring affects its existing setup assertions. Do not change the package entry point.

## Acceptance Checks

- An app-originated paused authoritative snapshot updates `session.player.is_playing` synchronously before a held provider refresh resolves.
- Stream termination requests one provider sample immediately and leaves exactly one bounded state-based recovery poll after sampling settles.
- Sampling remains single-flight and coalesces multiple requests into at most one follow-up.
- With `player()` unresolved, repeated toggles, next, and previous execute once each in captured accepted order rather than disappearing.
- Repeated toggles alternate explicit play and pause targets based on preceding accepted intents, not stale sampled state.
- Transport commands serialize, but provider sampling and artwork work do not block the next command.
- A delayed pre-transport sample cannot undo successful optimistic play, pause, or seek state. A later authoritative snapshot can correct it immediately.
- Adjacent not-yet-started seeks execute only the newest target, and every associated promise resolves when the retained attempt settles.
- Seeks separated by another intent remain distinct and execute in accepted order.
- A live backend failure produces only the existing error presentation and toast, resolves its caller, creates no unhandled rejection, and does not prevent later queued work.
- `session.loading` reflects unfinished accepted command work and never acts as an input lock or remains stuck after coalescing, failure, or cancellation.
- Disposal resolves queued and caller-visible in-flight command promises, executes no queued command, and permits no late mutation, toast, timer, sample, command, artwork projection, or unhandled rejection.
- Calls after disposal resolve without invoking the backend.
- Core and artwork subscriptions dispose once, and at most one poll timeout exists at every point.
- Existing controller methods, Compact and Sidebar callback signatures, artwork projection, waveform behavior, package entry point, and polling-only operation remain unchanged.

## Verify Commands

Run from the repository root:

```sh
bunx nx run-many -t typecheck test format:check package:check smoke --projects=opencode-music-player
```

The phase is complete only when every target passes.

## Non-Goals

- Parallel transport execution against one backend
- Coalescing toggles, next, previous, active seeks, or seeks separated by another intent
- Changing `music-core` subscription semantics or system-media provider behavior
- Pi event adoption, Pi queueing, or Pi lifecycle changes
- Artwork cache, catalog matching, download, conversion, image limits, Kitty placement, terminal escape sequence, or layout changes
- UI redesign, keybinding changes, storage migration, or new controls
- Removing optimistic feedback or provider-specific settling delays that remain necessary
- Stream support for `nowplaying-cli`
- Public controller queue APIs or test-only package exports
- Package version, release, or changelog publication
- Modifying, force-pushing, or adding commits to PR #40
