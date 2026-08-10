---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### Medium: Reentrant disposal can leave a retry timer alive

`packages/music-core/system-media.ts:417-427` invokes the invalidation listener before creating the retry timer. If that listener disposes the subscription, disposal observes `retryTimer === null`; control then returns to `handleTerminal`, which schedules a timer after disposal. The timer cannot restart the stream because `start()` checks `disposed`, but it remains live until its delay expires. This violates the phase package requirement that disposal cancel retry work and suppress late restart scheduling.

After the listener returns, check `disposed` and the generation again before scheduling, or create and register the timer before invoking user code while preserving immediate invalidation. Add a regression whose invalidation listener calls the returned disposer and assert that no active retry timer remains.

## Verification

The coder reports that `bunx nx run-many -t typecheck test format:check package:check --projects=music-core` passes with 81 tests. The prior partial-payload finding is fixed and covered by boolean-only and identity-only regressions.
