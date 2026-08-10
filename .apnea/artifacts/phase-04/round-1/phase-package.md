---
status: done
---

# Phase 4: Pi Event Adoption And Explicit Transport Queue

## Intent

Adopt the phase 1 authoritative media events in Pi and replace Pi's global busy-drop behavior with independent sampling and ordered transport lanes. Stream snapshots must update the status and waveform synchronously. Provider delay must not discard repeated controls, and reload or shutdown must detach every old-session effect.

This phase completes the cross-host integration. It preserves Pi's status line, commands, shortcuts, notifications, waveform behavior, polling-only fallback, extension entry point, and the published interfaces established by phases 1 through 3.

## Dependencies

- Phase 1 authoritative snapshot and stream-termination invalidation events, backend-owned clocks, and polling-only `nowplaying-cli` behavior must be present.
- Phase 2 independent OpenCode artwork projection must remain present and unchanged.
- Phase 3 OpenCode sampling, transport, and lifecycle lanes must be approved and green.
- Work on top of the approved phase 3 result based on `fix/music-player-sync` without modifying PR #40.

## Files To Touch

- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/test/index.test.ts`
- `packages/music-core/README.md`
- `packages/opencode-music-player/README.md`
- `packages/pi-music-dock/README.md`

Keep Pi queue and lifecycle types private to `extensions/music-dock/index.ts`. Do not add a public export or change another source file only to create a test seam.

## Files Not To Touch

- `packages/music-core/**/*.ts`
- `packages/music-core/tests/**`
- `packages/opencode-music-player/**/*.ts`
- `packages/opencode-music-player/**/*.tsx`
- `packages/opencode-music-player/tests/**`
- `packages/pi-music-dock/extensions/music-dock/format.ts`
- `packages/pi-music-dock/extensions/music-dock/waveform.ts`
- `packages/pi-music-dock/test/waveform.test.ts`
- Package manifests, versions, changelogs, lockfiles, release metadata, CI configuration, and smoke scripts
- `.apnea/state.json`
- PR #40 or its branch history

## Required Contract

1. Keep the default extension export, `createMusicDock(pi, overrides)`, `MusicDockDependencies`, status key, command names, command handler signatures, shortcut bindings, descriptions, and `Promise<void>` handler behavior unchanged.
2. Continue using only `ctx.ui.setStatus("music-dock", value)`. Do not take footer ownership or change status copy, icons, clipping, colors, waveform width, or rendering format.
3. Give each live Pi TUI session one lifecycle identity that owns its UI reference, player state, subscription disposer, poll timeout, waveform coordinator and interval, sample lane, transport queue, and transport revision. An old session must never operate on replacement-session resources.
4. Treat provider sampling, ordered transport execution, waveform scheduling, and synchronous status projection as separate lanes. No shared busy or loading flag may reject work in another lane.
5. Narrow subscription events by their discriminant. Apply `snapshot` state directly and synchronously while its session is live. Do not call or await `player()`, a transport command, a delay, a poll, or waveform work before assigning it.
6. Project every authoritative snapshot through Pi exactly once: replace the session's current player with `event.state`, pass that same state to the session-owned waveform coordinator, render one frame when it has a track, or clear status and stop the waveform when it does not. Do not use `mergePlayer` to weaken an authoritative snapshot.
7. A direct snapshot invalidates every older in-flight sample through a monotonically increasing sample request sequence. It may correct an optimistic transport result regardless of the revision captured by an older sample.
8. Treat a stream-termination invalidation and a legacy omitted event as immediate sample requests. They must enter the single-flight sampling lane, not invoke `player()` directly.
9. Keep sampling single-flight and coalescing. Requests received during one sample produce at most one follow-up sample. A sampled result may project only when its lifecycle identity, request sequence, and captured transport revision remain current.
10. Maintain at most one poll timeout for a live session. Clear it when requesting a sample, and schedule exactly one replacement only after the sampling lane becomes idle. Keep the state-based 3/5/8-second policy for playing, paused, and idle state.
11. A backend without `subscribe` must still start with `player()` and continue indefinitely through the same 3/5/8-second polling lane. Do not add stream behavior to `nowplaying-cli` or assume a disposer exists.
12. Represent each accepted toggle, next, and previous invocation as a private queued intent. Remove the global `busy` admission guard. Preserve every supported discrete intent in invocation order without coalescing.
13. Capture each toggle as an explicit play or pause intent at enqueue time. Use the newest active or queued play/pause target before falling back to the projected player's `is_playing` value. A later sample or snapshot must not reinterpret that intent.
14. Unsupported optional operations resolve immediately without queueing, backend invocation, optimistic projection, notification, or refresh. In particular, a captured pause requires `backend.pause`, next requires `backend.next`, and previous requires `backend.previous`.
15. Run at most one backend transport command at a time. A command may start while provider sampling remains unresolved. Release the command lane as soon as its backend attempt and live projection or handled error settle; do not hold it for the 120/150 ms reconciliation delay or `player()`.
16. After live toggle success, increment the transport revision and preserve the existing immediate icon and waveform feedback, including `fetched_at`. After live next or previous success, increment the revision without inventing new optimistic track state.
17. Preserve the existing 120 ms toggle and 150 ms skip settling delays, but detach them from the command lane. Their completion may request reconciliation only if the originating session is still live. Consume delay rejection without an unhandled rejection.
18. A live backend failure produces the existing error notification exactly once and resolves its command caller. It does not project optimistic success, increment the transport revision, flush the queue, reject a command or shortcut promise, or stop later queued intents.
19. Reload and shutdown cancellation are no-ops from the caller's perspective. Resolve all queued and caller-visible in-flight command promises immediately, start no queued backend call, and keep rejection handling attached to an already-started backend promise.
20. Mark a session inactive before releasing any owned resource. Late sample, command, delay, event, timeout, or waveform callback cannot set status, notify, schedule work, start a command, mutate player state, or affect a replacement session.
21. Reload must fully dispose the prior live session before creating and subscribing the replacement. Shutdown must clear status through the event's `ctx.ui` even if the captured session UI has already been released.
22. Disposal must be idempotent. Invoke the session subscription disposer once, clear its poll once, dispose its waveform coordinator once, clear queued work, and suppress every later callback.
23. Keep the waveform coordinator Pi-owned and session-owned. A replacement session gets a clean coordinator lifecycle; no old interval may render against the new session, and pause retains the existing decay-to-flat behavior.
24. Preserve handled transient sampling failures. An applicable live poll failure remains silent and reaches the next bounded poll; stale or disposed failures are consumed silently.
25. Preserve package boundaries. Pi consumes the public `MusicChangeEvent` contract from `@naxodev/music-core`; it must not copy core decoder logic, import OpenCode internals, expose its scheduler, or add Bun-only runtime dependencies to `music-core`.

## Implementation Steps

1. Replace the current global `disposed`, poll, event disposer, waveform, and `RefreshSession.busy` arrangement with one private live-session record.
   - Store a unique lifecycle identity or generation and an `active` flag.
   - Store session-owned UI, player, subscription disposer, poll timeout, and waveform coordinator.
   - Store sample state: active flag or promise, one pending follow-up flag, request sequence, and the transport revision captured by each call.
   - Store transport state: ordered pending intents and one active intent.
   - Keep a single `currentSession` reference only for locating the live owner; asynchronous continuations must also compare their captured session identity.

2. Create the waveform coordinator during successful TUI session setup.
   - Keep the existing injected interval scheduler and `Date.now` behavior.
   - Bind its render callback to the owning session, not mutable replacement-session globals.
   - Keep `renderStatus` output unchanged.
   - Route both sampled and snapshot state through one synchronous Pi projection helper. Let that helper distinguish authoritative replacement from sampled `mergePlayer` reconciliation before updating waveform and status.

3. Refactor sampling into a session-scoped single-flight lane.
   - Every request first confirms that its session remains current and active, increments the request sequence, and clears that session's poll.
   - If a sample is active, set one pending follow-up marker and return the lane's current drain promise.
   - Before each `backend.player()` call, capture lifecycle identity, request sequence, and transport revision.
   - Apply the result through sampled `mergePlayer` projection only if all captured guards still match.
   - Consume stale success and failure without UI or scheduling effects.
   - Drain at most one coalesced follow-up at a time, then schedule one bounded poll only when the lane is idle and live.

4. Centralize poll ownership in the live session.
   - Always clear the existing timeout before storing a replacement.
   - Select 3 seconds while playing, 5 seconds while paused with a track, and 8 seconds while idle.
   - Have the timeout clear its stored handle and call the same sample request function.
   - Never let an old timeout request a replacement-session sample.

5. Consume the phase 1 subscription event precisely.
   - Subscribe before starting the initial sample so a fast stream event cannot be missed.
   - On `event?.type === "snapshot"`, increment the sample request sequence, project `event.state` synchronously as authoritative, and reconcile the sole poll deadline from that state.
   - On `event?.type === "invalidation"`, request an immediate sample. Do the same for an omitted legacy event.
   - Do not convert a valid snapshot into an invalidation or fallback refresh.
   - Preserve the optional subscription and synchronous disposer contract.

6. Define a private discriminated transport intent for `play`, `pause`, `next`, and `previous`.
   - Store one resolve callback per invocation so each accepted handler promise has explicit ownership.
   - Keep queue ordering FIFO and do not merge repeated toggles or skips.
   - Derive a toggle's explicit target from the last active or pending play/pause intent, then projected state.
   - Reject no callers. Return an already-resolved promise for inactive sessions or unavailable optional methods.

7. Implement one non-reentrant transport runner.
   - Remove the head intent, mark it active, capture the session lifecycle, and defer backend invocation by at most a microtask.
   - Recheck lifecycle immediately before invoking the backend so disposal between enqueue and execution starts no work.
   - Invoke exactly the method represented by the captured intent.
   - Attach success and rejection continuations immediately so fire-and-forget shortcut or command handlers cannot cause unhandled rejections.
   - Settle the active caller once, clear the active slot, and start the next queued intent in a later microtask while live.

8. Preserve live success and failure presentation.
   - On play or pause success, increment the transport revision, update only `is_playing` and `fetched_at` on an existing player, then set and frame the session waveform exactly as today.
   - On next or previous success, increment the revision without clearing status early.
   - Start the existing settling delay as detached reconciliation work and allow the next command to run immediately.
   - On live failure, call `ctx.ui.notify(errMsg(error), "error")` once and continue the queue.
   - If disposal won the race, consume completion without revision, projection, waveform, status, notification, delay, refresh, or caller rejection.

9. Make reload and shutdown dispose explicit ownership.
   - Mark the old session inactive and detach it from `currentSession` before invoking user or timer callbacks.
   - Resolve and remove all queued intents without backend calls.
   - Resolve the active intent's caller immediately while leaving its backend completion observed.
   - Clear pending sample requests and prevent the active sample from scheduling follow-up work.
   - Invoke the subscription disposer, clear the poll, and dispose the waveform coordinator exactly once.
   - Clear the old status, null retained UI and player references where useful, and make repeated disposal harmless.
   - On `/reload`, finish this sequence before creating the new session, subscription, waveform owner, and initial sample.

10. Upgrade the test harness in `packages/pi-music-dock/test/index.test.ts` without exposing production internals.
    - Capture shortcut handlers as well as slash-command handlers when needed to prove both retain their existing asynchronous contract.
    - Extend deferred helpers to support rejection and explicit settlement checks.
    - Keep timers and intervals deterministic and inspect active ownership rather than using wall-clock waits.
    - Add event listener typing that can emit authoritative snapshots, invalidations, and legacy omitted events.

11. Add deterministic authoritative-event and stale-sample regressions.
    - Hold an initial or event-triggered `player()` unresolved, emit a paused authoritative snapshot, and assert the status icon changes to `▶` synchronously with no additional sample.
    - Emit a changed-track snapshot and assert its title renders before the held sample settles.
    - Settle the older sample and assert it cannot overwrite the snapshot.
    - Emit stream termination, assert exactly one immediate sample request, settle it, and assert exactly one state-based recovery timeout remains.
    - Fire that timeout and prove it re-enters the same single-flight lane.

12. Add deterministic ordered-control regressions.
    - Keep a provider sample unresolved, invoke repeated toggles, next, and previous, and assert every supported backend method runs exactly once in captured FIFO order.
    - Hold the first backend command and assert later commands do not start concurrently.
    - Prove repeated toggles become alternating explicit play and pause targets even though sampled state is stale.
    - Prove the second backend command begins after the first backend attempt settles but before its reconciliation delay or provider refresh settles.
    - Resolve all accepted handler promises and assert none reject.
    - Reject one live command, assert one existing notification, and prove the next queued command still runs.

13. Add deterministic polling-only and lifecycle regressions.
    - Use a backend that omits `subscribe`; prove initial sampling and successive playing, paused, and idle polls retain 3/5/8-second bounds.
    - Reload with an old subscription, poll, waveform interval, sample, command in flight, and more commands queued. Assert all old resources are inactive before replacement setup and queued backend methods never run.
    - Assert reload immediately resolves old queued and caller-visible in-flight command promises.
    - Settle or reject old sample, command, delay, event, timeout, and interval callbacks after reload. Assert no old status, notification, timer, command, or sample affects the replacement.
    - Shutdown under the same pending conditions. Assert status is cleared, all command callers resolve, and every late effect remains suppressed.
    - Repeat reload disposal and shutdown to prove disposer, timeout, interval, and promise settlement are idempotent.

14. Update runtime documentation without changing public interfaces.
    - In `packages/music-core/README.md`, retain the authoritative snapshot, terminal invalidation, optional subscription, polling-only provider, backend-owned clock, and disposer contract. Clarify that hosts project snapshots directly and use invalidation only for recovery if needed.
    - In `packages/opencode-music-player/README.md`, state that authoritative snapshots project immediately and transport execution is independent from bounded recovery sampling and artwork work. Do not document private queue types.
    - In `packages/pi-music-dock/README.md`, describe immediate snapshot projection, ordered repeated controls, 3/5/8-second polling-only and recovery behavior, and complete reload/shutdown cleanup. Keep installation, commands, shortcuts, status composition, requirements, and manual verification unchanged except for accurate runtime details.

15. Run package and workspace acceptance checks.
    - Verify the packed Pi extension still registers all three slash commands through Pi RPC smoke testing.
    - Verify the OpenCode packed consumer still loads its existing package entry points.
    - Verify `music-core` package contents and types expose the approved phase 1 API and do not acquire a Bun runtime dependency.
    - Treat any archive, export, command, shortcut, peer range, or entry-point drift as a regression rather than expanding this phase.

## Acceptance Checks

- A stream-originated pause updates Pi's status icon and waveform synchronously before a held provider sample resolves and without another `player()` call.
- A stream-originated track change renders the new title and artist immediately, and an older sample cannot restore the previous state.
- Stream termination requests one immediate provider sample and leaves exactly one bounded 3/5/8-second recovery poll after sampling settles.
- Pi remains fully functional when `MusicBackend.subscribe` is absent, including initial state and repeated state-based polling.
- Provider sampling stays single-flight and multiple requests during one sample produce at most one follow-up.
- During a held refresh, repeated toggles, next, and previous execute once each in captured FIFO order; none are dropped behind a busy latch.
- Repeated toggles alternate explicit play and pause targets from accepted intent history rather than stale provider state.
- Transport commands never overlap, but the next command does not wait for reconciliation delay or provider refresh.
- A stale sample cannot overwrite a successful optimistic toggle or a newer authoritative snapshot. A newer authoritative snapshot may correct optimistic state immediately.
- A live command failure emits only the existing error notification, resolves its caller, creates no unhandled rejection, and does not prevent later queued work.
- Unsupported, post-reload, and post-shutdown controls resolve without backend work or notifications.
- Reload disposes the old subscription, poll, waveform interval, sample generation, queue, and caller-visible active command before replacement setup.
- Shutdown clears status and suppresses every late sample, command, stream, delay, timeout, interval, notification, and follow-up request.
- No old-session callback can mutate or schedule work for a replacement session.
- Existing Pi status text, icons, clipping, waveform appearance and decay, commands, shortcuts, descriptions, notification copy, reload flow, shutdown flow, extension exports, and dependency injection surface remain unchanged.
- Core, OpenCode, and Pi package checks and packed-package smoke consumers pass together with no public export or entry-point drift.

## Verify Commands

Run from the repository root:

```sh
bunx nx run-many -t typecheck test format:check package:check smoke --projects=pi-music-dock
bunx nx run-many -t typecheck test format:check package:check -p music-core opencode-music-player pi-music-dock
bunx nx run-many -t smoke -p opencode-music-player pi-music-dock
bun run check
```

The phase is complete only when every command passes.

## Non-Goals

- Pi visual redesign, footer ownership, new controls, new commands, or keybinding changes
- Seek support or seek coalescing in Pi
- Parallel transport execution against one backend
- Changing `music-core` event types, decoder behavior, clock behavior, provider commands, stream restart policy, or `nowplaying-cli`
- Changing OpenCode controller, artwork, Kitty rendering, UI, storage, or package APIs
- Changing waveform engine behavior, colors, cadence, dimensions, seeding, ANSI output, or decay rules
- Exposing Pi queue, sampling, lifecycle, or waveform ownership as public API
- Package version, release, changelog, manifest, peer dependency, or CI changes
- Modifying, force-pushing, or adding commits to PR #40
