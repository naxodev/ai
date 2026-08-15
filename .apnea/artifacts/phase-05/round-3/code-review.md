---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. It stays within singleton auto-start, listener-first ownership, bounded Effect scheduling, and terminal skew handling.

## Findings

### Critical — Selected listener-first shutdown remains deadlocked

No product fix was retained. The real selected blocked-work topology still times out, while the retained fixture injects an externally owned coordinator and therefore does not exercise production ownership. The combined coordinator/provider scope waits for connection children before interrupting coordinator work those children may depend on. Apply the package-authorized shared-graph migration so listener, provider, and coordinator ownership are distinct and shutdown can refuse acceptance, interrupt coordinator work, await connections, finalize the provider, and release the listener without cyclic waits. Retain the regression through the actual selected topology.

### High — Process-level singleton and loser non-interference evidence remains absent

The required daemon-level bind race is still missing: exactly one listener/provider winner, completed hello against that winner, a tagged/nonzero loser with zero provider ownership, and proof that the loser cannot unlink, chmod, close, or otherwise disturb the winner's socket.

### High — Required startup and skew evidence remains incomplete

The suite still lacks deterministic Effect `TestClock` pacing/capping/exhaustion/success/interruption, 20-way `connectOrStart` convergence, exact marker release on interruption and complete-workflow spawn failure, release-diagnostic retention, and terminal incompatibility races before acquisition, after acquisition, and while waiting.

## Verification

The coder retained no product changes and reports 73 focused tests and 203 full music-core tests passing, with `git diff --check` clean. Those tests exclude the reproduced selected-topology deadlock and do not satisfy the remaining Phase 5 acceptance matrix.
