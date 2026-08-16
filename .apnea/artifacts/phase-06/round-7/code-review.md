---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

### High — Round 7 changes protocol negotiation outside the Phase 6 package

The package says to preserve Phase 1–5 protocol negotiation and permits `protocol.ts` changes only for stable bounded-error/schema behavior. Round 7 instead removes the established requirement that every negotiated session include `state-replay`, changes the explicit client's hello validation, conditionally removes the server state forwarder, and rewrites baseline protocol/server tests from `UNSUPPORTED_CAPABILITY` to successful transport-only negotiation.

That is a public protocol semantic change made solely to simplify one load test, not a bounded fan-out correction. It violates package scope and must be reverted before deeper approval. The prior review's transport-only suggestion does not supersede the approved package; an implementation must not apply an example that conflicts with baseline protocol requirements.

Keep `state-replay` mandatory and prove healthy-peer continuity without changing negotiation. One deterministic option is:

1. let the oversized target close;
2. emit a bounded replacement snapshot;
3. await that exact coordinator revision through its existing Effect state stream/observation boundary (no sleeps or polling);
4. connect a normal state-replay/transport explicit client;
5. prove replay and a protocol command succeed while the listener remains live.

This reaches the required real connection/writer/protocol path while preserving the approved capability contract.

## Code review

Deep approval is blocked by package drift. The subprocess fixture itself now has bounded stderr/exit cleanup, selected-artifact assertions, listener-presence evidence, and a real explicit-client command, but those assertions depend on the out-of-scope transport-only capability change and therefore cannot be accepted as Phase 6 evidence yet.

## Verification

The coder reports the oversized child test, 8 focused capability/load tests, 135 combined tests, and the 242-test build/typecheck/test/format/package matrix passing with timer and diff checks. Green tests that intentionally rewrite the approved capability baseline do not resolve the package violation.
