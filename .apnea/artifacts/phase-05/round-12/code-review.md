---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. The current implementation still does not satisfy its scoped server-finalization and acceptance-evidence requirements.

## Findings

### Critical — Selected listener-first shutdown has a reproduced production deadlock

The coder moved the blocked-sampling fixture temporarily to the real selected `layerWithHooks(..., coordinatorGraph)` topology and scope close timed out after five seconds. That confirms the cycle in `packages/music-core/session/server.ts:835-881`: connection finalization waits on coordinator work, while coordinator interruption occurs only after connection fibers are joined. The test was reverted, so the retained green suite still bypasses the defect. Implement the package-requested ownership split between bound listener, coordinator interruption/provider finalization, and connection scopes; retain the selected-topology blocked-work regression as passing evidence.

### High — Process-level singleton and non-interference evidence remains absent

The bind race still uses two server graphs in one process. The package requires daemon contenders, exactly one provider winner, a completed hello against the winner, a tagged/nonzero loser, and proof that the loser cannot unlink, chmod, close, or otherwise disturb the winner's socket.

### High — Startup acceptance evidence remains incomplete

The suite still lacks deterministic `TestClock` pacing/capping/exhaustion/success/interruption, 20-way `connectOrStart` convergence, exact marker release on interruption and complete-workflow spawn failure, release-diagnostic retention, and terminal incompatibility before/after acquisition and while waiting.

## Verification

No product change was retained this round. The coder reports 73 focused tests and 203 full music-core tests passing with build, typecheck, format, package, timer scan, and `git diff --check`. The retained tests exclude the reproduced selected-topology deadlock and do not satisfy the remaining acceptance matrix.
