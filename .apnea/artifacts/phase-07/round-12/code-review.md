---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 12 uses only allowed test paths and adds valid explicit-client evidence, but several package-required races and real-server behaviors remain untested.

## Findings

### High — Coordinator cancellation/finalization and distinct in-flight capacity remain unproved

Round 12 does not address the prior coordinator gaps. There is still no deterministic test that:

- interrupts the admitting caller around admission/start and proves no ownerless entry;
- interrupts/disconnects the first caller while an equal-key joiner remains and proves the coordinator-owned lookup continues;
- closes the coordinator scope during a blocked read and proves provider interruption/finalization, waiter settlement, entry removal, and cleanup ordering;
- fills capacity with distinct in-flight identities, receives a bounded outcome for excess work, then releases/fails a slot and retries successfully.

These are explicit cache ownership/cancellation requirements and previously defective implementation paths. Extend the Effect-native fixture with interruption/finalization observations and force each race under bounded cleanup.

### High — Real-server blocked-read and final wire containment coverage remains absent

The package still lacks real selected-server tests for concurrent equal requests from different clients, post-read authority change, provider failure followed by retry, state and another client's transport progressing during a blocked read, unavailable/malformed/too-large results, and disconnecting one pending client without affecting others.

It also lacks a boundary test proving an upstream-accepted maximum response fits the mandatory lane and an unexpectedly oversized coordinator response becomes one correlated `too-large` result without closing the connection. Coordinator/unit coverage cannot substitute for these socket/writer semantics.

### High — Reconnecting artwork delegation and generation fencing remain untested

The explicit client now has useful correlation, disposal, and connection-loss tests, but no managed/reconnecting test proves artwork is delegated exactly once to generation A, rejects on A's loss, is neither queued nor replayed to B, and cannot settle from a late A completion after B adoption or disposal. This is an explicit Phase 7 acceptance requirement.

### Medium — Native timeout/normal-command compatibility evidence remains incomplete

The native adapter suite still does not distinguish timeout from ordinary execution failure or pair `media-control get --now` artwork behavior with evidence that normal sampling/stream commands retain `--no-artwork`. Add the remaining focused compatibility cases.

## Verification

Round 12 reports the required focused command, 194 passing tests across all five phase files, a green 251-test Nx matrix, `git diff --check`, and a clean forbidden-boundary scan. Verification is green for implemented coverage; the verdict is based on the package acceptance cases still absent.

## Resolved findings

Explicit-client tests now prove independent request-ID correlation with out-of-order artwork responses, `DISPOSED` settlement for pending work, and `CONNECTION_LOST` rather than command indeterminacy on socket loss. Scripted negotiation can opt into `native-artwork` without changing old-peer defaults.
