---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 14 uses only allowed client source/test paths and fixes generation fencing, but coordinator cancellation/capacity and selected-server wire/non-interference acceptance remain absent.

## Findings

### High — Coordinator cancellation/finalization and distinct in-flight capacity remain unproved

No coordinator tests changed in Round 14. The phase still lacks deterministic evidence for:

- interruption around the uninterruptible admission/start boundary without leaving an ownerless entry;
- first-caller interruption while an equal-key joiner remains, proving caller loss does not cancel shared coordinator work;
- coordinator-scope shutdown during a blocked native read, including provider interruption/finalization, all waiter settlement, entry removal, and retry/cleanup ordering;
- finite distinct-key in-flight admission, stable excess outcome, and recovery after release/failure.

Add fixture observations for interruption and finalization and force these races under bounded cleanup. These are explicit package requirements and previously defective paths.

### High — Selected-server blocked-read isolation and final wire containment remain absent

The real server suite still does not prove concurrent equal requests from different clients share one provider read, post-read authority changes discard bytes, state and another client's command progress while artwork is blocked, disconnecting one pending client does not affect joiners, or provider failure is correlated and retryable without caching.

Stable unavailable/malformed/too-large wire outcomes are also missing, including an exact accepted payload boundary and an unexpectedly oversized coordinator response that must become one correlated `too-large` response without closing the connection. Add real selected-server/socket coverage through the bounded mandatory lane.

### Medium — Managed disposal fencing lacks its required late-completion case

The new reconnect test now genuinely retains generation A's Promise through terminal transition and resolves it late; the wrapper correctly rejects it and does not replay to B. The package also requires fencing after wrapper disposal. Add a pending artwork call whose underlying generation resolves after `managed.dispose()` and prove the caller remains `DISPOSED` with no stale success.

## Verification

Round 14 reports the reconnect-focused test, 196 passing tests across all five phase files, a green 253-test Nx build/typecheck/test/format/package matrix, `git diff --check`, and a clean forbidden-boundary scan. Verification is green for present coverage; the verdict is based on required acceptance cases still absent.

## Resolved findings

`ReconnectingMusicSessionClient.artwork()` now captures the active generation token and checks it on both Promise branches. Late success/failure from a replaced generation is converted to the current lifecycle error, while current-generation outcomes retain their original result/error. The revised test leaves A's resolver pending across loss, adopts B, resolves A late, and proves rejection plus zero replay to B.
