---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan. It requires successful socket bind—not a long-lived sidecar—to remain final singleton authority.

## Findings

### Critical — Selected listener-first shutdown still deadlocks on blocked coordinator work

`packages/music-core/session/server.ts:823-869` still waits for connection children before interrupting the selected coordinator worker they may depend on. The blocked-work test remains externally composed and bypasses production ownership. Replace the manually nested coordinator scope with the package-requested listener/service Layer topology and run the regression through the selected graph.

### High — A post-publication cleanup failure can strand a live reservation

Atomic `link()` publication fixes the partial-payload crash window. However, after `link(temporaryPath, path)` succeeds, `acquireBindLock` unlinks the temporary name before returning (`packages/music-core/session/server.ts:343-362`). If that temporary unlink fails, control enters `catch`, closes the handle, retries only temporary cleanup, and throws without removing the already-published `path`. Its payload contains the still-live library process PID, so subsequent starts in that process conservatively refuse it forever. Track publication and exact-clean the published link on every post-publication acquisition failure, or treat private-temp cleanup failure as a retained diagnostic without abandoning valid published ownership.

### High — The reservation remains long-lived authority rather than bind-only coordination

The complete reservation is still held until listener shutdown. Once bind/hardening succeeds, later contenders can serialize on the reservation, inspect the existing socket, and fail without keeping the sidecar authoritative for the listener's whole lifetime. Release it after atomic listener acquisition so the socket is final authority, while retaining crash-safe stale recovery for the acquisition window. Keep this artifact's policy and evidence aligned with the managed-runtime security boundary.

### High — Required process and startup acceptance evidence remains incomplete

There is still no separate-daemon bind race with winner hello and loser path non-interference. Deterministic `TestClock` startup lifecycle, 20-way convergence, exact marker release on interruption/spawn failure, release diagnostics, and terminal skew-race evidence also remain outstanding. No focused test was added for atomic publication or its failure paths.

## Verification

The coder reports 73 focused tests and 203 full music-core tests passing with build, typecheck, format, package, timer scan, and `git diff --check`. Changes remain in allowed files, but the shutdown defect, reservation failure path, and missing acceptance evidence prevent approval.
