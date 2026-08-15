---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. Atomic publication and post-hardening reservation release now restore the socket as long-lived singleton authority, but the phase's lifecycle and evidence requirements remain incomplete.

## Findings

### Critical — Selected listener-first shutdown still deadlocks on blocked coordinator work

`packages/music-core/session/server.ts:835-881` still clears and awaits connection children before closing the selected coordinator scope. A connection forwarder can wait for a blocked coordinator worker, while that worker is interrupted only by the later `closeCoordinator`. The blocked-sampling fixture continues to acquire its coordinator outside the selected post-bind graph and therefore bypasses this production cycle. Replace the manually nested scope with a shared listener/coordinator ownership topology whose cancellation cannot deadlock, then run the regression through the actual selected graph.

### High — Process-level singleton and non-interference evidence remains absent

The reservation publication and release failure paths now address the prior code findings, but the retained race still starts two server graphs in one process. The package requires two daemon contenders that bypass marker coordination, exactly one provider winner, a completed hello against that winner, and proof that the loser cannot unlink, chmod, close, or otherwise disturb the winning socket. Add that process-level evidence, including the tagged/nonzero loser outcome.

### High — Startup acceptance evidence remains incomplete

The suite still lacks deterministic `TestClock` pacing/capping/exhaustion/success/interruption, 20-way `connectOrStart` convergence on one provider and daemon instance, exact marker release on interruption and complete-workflow spawn failure, release-diagnostic retention, and terminal incompatibility before/after acquisition and while waiting.

## Verification

The coder reports 73 focused tests and 203 full music-core tests passing with build, typecheck, format, package, timer scan, and `git diff --check`. Changes remain within allowed files, but the selected-graph shutdown defect and missing acceptance matrix prevent approval.
