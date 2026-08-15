---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. The implementation still fails its listener-first lifecycle requirement and lacks required acceptance evidence.

## Findings

### Critical — Selected listener-first shutdown still has a reproduced deadlock

No product fix was retained. Re-running the blocked-sampling fixture through the selected `layerWithHooks(..., coordinatorGraph)` topology again caused `Scope.close` to time out. The current combined coordinator/provider graph therefore still creates the cycle in `packages/music-core/session/server.ts`: connection finalization waits for coordinator work whose interruption occurs only after the connections are joined. Split provider and coordinator ownership so shutdown can stop/refuse acceptance, interrupt the coordinator, await connection children, finalize the provider, and finally release the listener without cyclic waits. The blocked-work regression must exercise this actual selected topology.

### High — Process-level singleton and non-interference evidence remains absent

The package still requires two daemon contenders, exactly one provider winner, completed hello against that winner, a tagged/nonzero loser, and proof that the loser cannot unlink, chmod, close, or otherwise disturb the winning socket.

### High — Startup acceptance evidence remains incomplete

Still missing are deterministic `TestClock` pacing/capping/exhaustion/success/interruption; 20-way `connectOrStart` convergence; exact marker release on interruption and complete-workflow spawn failure; release-diagnostic retention; and terminal incompatibility before/after acquisition and while waiting.

## Verification

No product change was retained. The coder reports 73 focused tests and 203 full music-core tests passing, plus successful build, typecheck, format, package, timer scan, and `git diff --check`. The green suite continues to exclude the reproduced selected-topology failure and does not cover the remaining acceptance matrix.
