---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. It requires secure runtime-artifact policy in `config.ts` and socket bind as final singleton authority.

## Findings

### Critical — Bind reservation still has an unrecoverable partial-write crash state

No fix was retained. `${socketPath}.bind-lock` is created and interpreted privately in `server.ts`, held for the listener lifetime, and invisible to managed discovery. A crash/interruption after `open("wx")` but before the PID payload is completely written and synced leaves an empty or malformed reservation. Removing such a file immediately is unsafe while a live contender may still be writing it, but preserving it means all later daemons fail forever. Replace this sidecar design with a process-death-released primitive or a config/discovery-owned protocol whose acquisition representation is safe and classifiable at every crash point; socket bind must remain final authority.

### Critical — Selected listener-first shutdown still deadlocks on blocked coordinator work

`packages/music-core/session/server.ts:808-854` still awaits connection children before closing the selected coordinator scope. Connection forwarding can wait for a blocked coordinator worker that is interrupted only by the later scope close. The blocked-sampling fixture continues to bypass the selected graph. Redesign the shared ownership scope rather than reordering the existing nested close call, and run the regression through production topology.

### High — Bind and startup acceptance evidence remains incomplete

The retained bind race is same-process and does not prove separate daemon processes, completed hello against the winner, or loser non-interference with the winner's path. Deterministic `TestClock` lifecycle coverage, 20-way `connectOrStart` convergence, exact release on interruption/spawn failure, release diagnostics, and terminal skew races also remain outstanding.

## Verification

No product change was retained this round. The coder reports 73 focused tests and 203 full music-core tests passing with build, typecheck, format, package, timer scan, and `git diff --check`. The selected-topology defects and required evidence remain unresolved, so Phase 5 cannot be approved.
