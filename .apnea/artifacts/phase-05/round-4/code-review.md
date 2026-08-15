---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. The required atomic graph-interface migration is explicitly within its allowed server, executable, and test seams.

## Findings

### Critical — Selected listener-first shutdown remains deadlocked

No product change was retained. The selected blocked-work topology still reproduces a cancellation cycle, while the retained green fixture externally owns its coordinator and bypasses production graph ownership. A finalizer reorder is insufficient because provider and coordinator currently share one scope. Split the shared graph contract into distinct listener, provider, and coordinator ownership so shutdown can stop acceptance, interrupt coordinator work, await dependent connection children, finalize the provider, and release the listener without a cycle. Retain a passing blocked-work regression using the real selected topology.

### High — Process-level singleton and loser non-interference evidence remains absent

The package-required daemon bind race still needs to prove exactly one listener/provider winner, completed hello against that winner, a tagged/nonzero loser with zero provider ownership, and no loser unlink/chmod/close interference with the winning socket.

### High — Startup and skew acceptance evidence remains incomplete

Still missing are deterministic Effect `TestClock` pacing/capping/exhaustion/success/interruption, 20-way `connectOrStart` convergence, exact marker release on interruption and complete-workflow spawn failure, release-diagnostic retention, and terminal incompatibility races before acquisition, after acquisition, and while waiting.

## Verification

No product change was retained. The coder cites the previous 73 focused and 203 full music-core tests passing with `git diff --check` clean. The retained suite excludes the reproduced selected-topology failure and does not satisfy the remaining Phase 5 acceptance matrix.
