---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan, but the current Bun runtime behavior means the implementation needs an atomic, crash-safe reservation primitive or an explicitly revised approved contract before it can satisfy socket singleton authority.

## Findings

### Critical — Bind reservation publication is not crash-safe

No fix was retained. The current exclusive-create-then-write sidecar has an unavoidable interval where a crash leaves an empty/malformed permanent authority that managed discovery cannot classify or recover. This is not safely repairable by deleting malformed files because a live winner may still be writing one. Replace it with an atomically published, already-complete ownership representation (for example, prewrite/sync privately and atomically publish with an exclusive filesystem operation), keep policy and guarded stale recovery in `config.ts`, and release the reservation once bind/hardening makes the socket authoritative. If repository-pinned platform APIs cannot provide this contract, escalate for an approved dependency or phase-package revision rather than retaining the known wedge.

### Critical — Selected listener-first shutdown still has a coordinator/connection cancellation cycle

`packages/music-core/session/server.ts:808-854` still waits for connection children before interrupting the selected coordinator worker they may depend on. The existing blocked-work test remains externally composed and therefore bypasses production ownership. The repeated failed reorderings confirm that the manually nested `Scope` design must be replaced, consistent with the package's requested split listener service/Layer and dependency-owned finalization topology.

### High — Required acceptance evidence remains incomplete

The suite still lacks a process-level daemon bind race with winner hello and loser non-interference, deterministic `TestClock` startup lifecycle coverage, 20-way `connectOrStart` convergence, exact marker release on interruption/spawn failure, release diagnostics, and terminal skew races.

## Verification

No product change was retained this round. The coder reports 73 focused tests and 203 full music-core tests passing with build, typecheck, format, package, timer scan, and `git diff --check`. Those checks do not resolve the known reservation and shutdown defects, so approval is not possible.
