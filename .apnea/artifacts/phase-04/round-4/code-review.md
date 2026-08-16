---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan, and Round 4 remains within its allowed client/test scope.

## Findings

### Critical — Removing the outer resource bracket reopens the successful-connect/adoption leak window

Round 4 removes `Effect.acquireRelease` and now yields the connector result directly before calling `#adopt` (`packages/music-core/session/client.ts:1280-1290`). The new guards inside `connectOrStartMusicSessionEffect` own a client only while discovery/cleanup is still interrupted. Once that Effect reports success, there is again no owner for the client until the subsequent mutable `#adopt` call. If scope disposal/interruption wins in that handoff, the connector has already completed so its `onInterrupt`/late-Promise cleanup does not run, while `shutdown()` cannot dispose the client because it was never placed in `#active`.

The new tests interrupt discovery or cleanup before the connector succeeds; neither forces a successful connector completion to race disposal before adoption. Replacing the lifetime-wide finalizer was necessary, but simply deleting it is not sufficient. Use bounded per-attempt/per-generation scoped ownership (closed when that generation ends) or an equivalent uninterruptible ownership transfer, and deterministically prove a completed client that loses the adoption race is disposed.

### High — Managed lifecycle state still bypasses the package's required Effect synchronization

The package requires all mutable managed lifecycle to live in Effect synchronization. `ManagedMusicSessionClient` instead stores generation, active client, disposed/terminal flags, retained values, lifecycle, and listener sets in ordinary mutable fields (`client.ts:1033-1042`) and performs check-then-mutate transitions directly from socket callbacks, public methods, scope finalization, and the supervisor. `Deferred` is used only for wakeups; it does not serialize those lifecycle transitions. This leaves the required atomic generation/live checks and connect/dispose ownership transfer dependent on callback scheduling rather than an Effect `Ref`/latch/semaphore transaction. Move the ownership/lifecycle transition state behind the required Effect synchronization boundary and keep Promise-facing getters as snapshots if needed.

## Verification

The coder supplied passing typecheck, focused, combined, full-target, timer-scan, and diff evidence (10 focused tests, 95 combined tests, 225 full tests). Round 3's cleanup-stage, stale-callback, and command-fixture findings are now covered, but the post-success adoption race is not.
