---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. It is confined to singleton auto-start, listener-first ownership, bounded startup scheduling, and version-skew policy; reconnect, load, artwork, and host migration remain out of scope.

## Findings

### Critical — The selected listener-first graph still deadlocks during shutdown

No product change was retained. As acknowledged in the coder result, the real selected blocked-work topology still times out while the green fixture supplies its coordinator externally and bypasses the ownership cycle. The combined coordinator/provider scope waits for connection children before interrupting coordinator work those children may depend on. Split the shared graph contract into distinct listener, provider, and coordinator ownership so shutdown can refuse new work, interrupt coordinator work, await connections, finalize provider ownership, and release the listener without a cycle. Retain the blocked-work regression through the actual selected topology.

### High — Process-level singleton and loser non-interference evidence remains absent

The package requires daemon contenders that bypass marker coordination, exactly one listener/provider winner, a completed hello against that winner, a tagged/nonzero loser, and proof that the loser cannot unlink, chmod, close, or otherwise disturb the winner's socket. This evidence is still missing.

### High — Required startup and skew evidence remains incomplete

The suite still lacks deterministic Effect `TestClock` pacing/capping/exhaustion/success/interruption, 20-way `connectOrStart` convergence on one launcher/listener/provider, exact marker release on interruption and whole-workflow spawn failure, release-diagnostic retention, and terminal incompatibility races before acquisition, after acquisition, and while waiting.

## Verification

The coder retained no product changes and cites the last unchanged-source verification: 73 focused tests and 203 full music-core tests passed, with `git diff --check` clean. Those green tests exclude the reproduced selected-topology deadlock and do not satisfy the remaining Phase 5 acceptance matrix.
