---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. The accumulated bind-reservation work matches the socket-as-final-authority requirement, but lifecycle correctness and acceptance evidence remain incomplete.

## Findings

### Critical — Selected listener-first shutdown remains deadlocked

No source fix was retained. The selected graph still awaits connection children before closing the selected coordinator scope, so a child blocked on coordinator work can prevent the interruption needed to release it. The externally composed green fixture bypasses that production ownership cycle. Split listener, provider, and coordinator scopes in the shared graph, establish non-cyclic shutdown ordering, and retain a passing blocked-work regression through the real selected topology.

### High — Process-level singleton and loser non-interference evidence remains absent

The existing bind race is same-process. The package requires daemon contenders, exactly one provider/listener winner, completed hello against that winner, a tagged/nonzero loser with zero provider ownership, and proof that the loser cannot unlink, chmod, close, or otherwise disturb the winner's socket.

### High — Startup and skew acceptance evidence remains incomplete

The suite still lacks deterministic Effect `TestClock` pacing/capping/exhaustion/success/interruption, 20-way `connectOrStart` convergence, exact marker release on interruption and complete-workflow spawn failure, retained release diagnostics, and terminal incompatibility races before acquisition, after acquisition, and while waiting.

## Verification

The coder reports 73 focused and 203 full music-core tests passing, including build, typecheck, format, package checks, timer scan, and clean diff validation. These green results exclude the reproduced selected-topology deadlock and do not satisfy the remaining Phase 5 acceptance matrix.
