---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains confined to allowed paths. The production client now has one owned socket callback set and explicit handshaking/active/terminal/disposed routing, resolving the prior two-reader handoff finding.

## Findings

### High — The Phase 3 acceptance matrix is still largely unimplemented

No client tests changed in this round, and the suite still contains only six tests: four Phase 2 handshake cases, one combined reverse-order/invalid-seek/wrong-action request case, and one negotiated-client happy path. The package requires deterministic evidence for the remaining semantics:

- unsolicited and duplicate responses followed by correctly settled newer requests;
- malformed transport data in addition to wrong action;
- request-local typed failure with preserved details followed by successful reuse;
- error/end/close races, once-only indeterminate settlement, future connection loss, and no replay/second connection;
- repeated disposal, pending/future `DISPOSED`, socket destruction once, and ignored late callbacks;
- wrong-instance, duplicate, stale, and out-of-order state authority;
- throwing/self-unsubscribing/idempotently unsubscribed listeners and late immediate delivery;
- malformed nested active frames, split/multiple frames, partial EOF, and explicit gap-free handshake delivery.

The package also calls for a reusable in-file scripted-daemon helper with deterministic accepted/received/closed signals; the one ad hoc request server cannot drive this matrix. Add the focused tests from sections 7–9 using the required failure-safe resource ownership.

## Verification

The coder reports all 41 focused tests, 163 music-core tests, package/build/typecheck/format targets, and the static scan passing. These are valid regressions and support the lifetime-reader refactor, but the unchanged client-test count leaves most Phase 3 acceptance checks without evidence.
