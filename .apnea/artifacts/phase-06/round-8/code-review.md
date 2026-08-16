---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

Round 8 correctly reverts the out-of-scope transport-only capability change. The cumulative implementation is again aligned with the Phase 6 package and preserves mandatory `state-replay` negotiation.

## Findings

### High — Healthy protocol-peer continuity after oversized containment remains unproven

No accepted replacement evidence was added. The isolated child still proves only that the oversized target finalizes and that the internal selected graph remains present/callable; it does not restore a bounded authoritative snapshot, connect a normal required-capability client, and prove replay plus a transport response through the real listener/writer/client path. The coder result explicitly lists this as unresolved.

The reported coordinator-state timeout is itself useful evidence that the post-overflow recovery path is not yet understood. Diagnose that synchronization rather than omitting the assertion. A deterministic fixture can subscribe/fork a filtered coordinator state observation before emitting the bounded replacement, await the exact daemon-instance/revision snapshot, and only then create the healthy client. If that observation cannot complete after one client's outbound overflow, determine whether the provider/coordinator event path was inadvertently disrupted; that would be a production Phase 6 defect, not merely a test inconvenience.

The gate still requires proof that frame-size failure is local across the selected socket protocol, not just local relative to direct coordinator calls.

### Medium — The required full verification matrix is red

The reported `nx run-many -t build typecheck test format:check package:check --projects=music-core` command exits 1 because the 20-concurrent managed-caller test fails with an occupied-peer startup error. Build/typecheck/format/package checks and the direct three-suite run pass, but this round supplies no successful rerun of the exact full matrix. The package requires Phase 1–5 regressions green; provide a passing full command or address the repeatedly disclosed convergence instability.

## Resolved findings

Mandatory `state-replay` negotiation, explicit-client validation, server forwarding, and baseline capability tests are restored. The child retains bounded stderr/process/artifact cleanup and now waits for target connection finalization.

## Verification

The oversized child test, 5 focused load tests, and 135 combined server/client/coordinator tests pass. The full target matrix reports 241 passing tests and one failure, so verification is not complete.
