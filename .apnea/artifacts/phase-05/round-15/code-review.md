---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. It explicitly permits the coordinated graph-interface changes required across `server.ts`, `music-sessiond.ts`, and existing tests; the fact that they must be applied atomically does not remove them from scope.

## Findings

### Critical — Selected listener-first shutdown remains deadlocked

No product change was retained. The selected topology still deterministically times out because the combined coordinator/provider graph cannot interrupt coordinator work before awaiting connection children that depend on it. Change the shared graph seam to express distinct provider and coordinator ownership, then finalize in a non-cyclic order: stop/refuse acceptance, interrupt coordinator work, await connections, finalize provider, and release listener ownership. Preserve all existing lifecycle behavior and retain a passing blocked-work regression through the real selected topology.

### High — Process-level singleton and non-interference evidence remains absent

The package still requires two daemon contenders, exactly one provider winner, completed hello against that winner, a tagged/nonzero loser, and proof that the loser cannot unlink, chmod, close, or otherwise disturb the winning socket.

### High — Startup acceptance evidence remains incomplete

Still missing are deterministic `TestClock` pacing/capping/exhaustion/success/interruption; 20-way `connectOrStart` convergence; exact marker release on interruption and complete-workflow spawn failure; release-diagnostic retention; and terminal incompatibility before/after acquisition and while waiting.

## Verification

No source changed this round. The coder cites the prior 73 focused and 203 full music-core tests plus `git diff --check`. These results exclude the reproduced selected-topology deadlock and do not satisfy the remaining acceptance matrix.
