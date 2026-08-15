---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan and already authorizes the required graph-contract migration. It explicitly requires a shared listener-first graph constructor, provider acquisition after bind, test-provider replacement through that topology, and non-cyclic coordinator/provider/connection finalization. A new package is not required to correct the defect within the listed files.

## Findings

### Critical — Selected listener-first shutdown remains deadlocked

No product change was retained. The real selected topology still has the reproduced cancellation cycle: connection finalization waits for coordinator work, while coordinator interruption occurs only after connection children are joined. Refactor the shared graph seam atomically across `server.ts`, `music-sessiond.ts`, and existing tests as the package permits, separating provider and coordinator ownership so the coordinator can be interrupted before awaiting dependent connections and the provider can finalize afterward. Retain a passing blocked-work regression through the actual selected topology.

### High — Process-level singleton and non-interference evidence remains absent

The package still requires two daemon contenders, exactly one provider winner, completed hello against that winner, a tagged/nonzero loser, and proof that the loser cannot unlink, chmod, close, or otherwise disturb the winning socket.

### High — Startup acceptance evidence remains incomplete

Still missing are deterministic `TestClock` pacing/capping/exhaustion/success/interruption; 20-way `connectOrStart` convergence; exact marker release on interruption and complete-workflow spawn failure; release-diagnostic retention; and terminal incompatibility before/after acquisition and while waiting.

## Verification

No product change was retained. The coder relies on the prior result of 73 focused and 203 full music-core tests passing plus `git diff --check`. Those green tests exclude the reproduced selected-topology deadlock and do not cover the remaining acceptance matrix.
