---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. Its allowed server, executable, and existing-test seams cover the required atomic ownership-graph migration.

## Findings

### Critical — Production selected-graph shutdown remains deadlocked

No product change was retained. The selected blocked-work topology still times out, while the green fixture externally composes its coordinator and does not prove production ownership. Separate listener, provider, and coordinator scopes in the shared graph so shutdown can stop acceptance, interrupt coordinator work, await dependent connection children, finalize provider ownership, and release the listener without a cycle. Keep the blocked-work test on the actual selected topology.

### High — Process-level singleton and non-interference proof is still missing

The package requires a daemon-level bind race showing one listener/provider winner, completed hello against the winner, a tagged/nonzero loser with zero provider ownership, and no loser unlink/chmod/close interference with the winning socket.

### High — Startup and skew acceptance proof is still incomplete

Missing evidence includes deterministic Effect `TestClock` pacing/capping/exhaustion/success/interruption, 20-way `connectOrStart` convergence, exact marker release on interruption and complete-workflow spawn failure, retained release diagnostics, and terminal incompatibility before acquisition, after acquisition, and while waiting.

## Verification

No product change was retained. The coder cites the previous 73 focused and 203 full music-core tests passing with `git diff --check` clean. Those tests exclude the reproduced selected-topology deadlock and do not satisfy the remaining Phase 5 acceptance matrix.
