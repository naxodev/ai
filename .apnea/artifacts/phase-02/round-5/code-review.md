---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 2 package remains aligned with the approved plan, and the cumulative source diff remains within its allowed protocol/client/server paths. The terminal-safe frame reader, same-major incompatibility, malformed/missing-capability hello cases, negotiated request classifications, and nested schema tests address the prior findings substantially.

## Findings

### High — Several explicit negotiated-boundary acceptance cases are still absent

The package requires compact real-socket evidence for the complete shared boundary. The new combined server test now covers malformed range, missing replay, second hello, duplicate ID, invalid action, and invalid seek, but it still does not cover:

- a valid state/transport request before hello, proving hello-first ordering after schema decoding;
- an oversized real-socket frame and isolation of that connection;
- incomplete EOF after a negotiated session (the existing pre-hello partial-frame baseline does not exercise the negotiated boundary);
- exactly one incompatibility response before the incompatible socket closes.

The package also requires pure major-mismatch negotiation evidence. The same-major disjoint-range test replaced the only real major mismatch, while the protocol tests currently cover only same-major disjoint ranges. Add these focused assertions; they belong to the stated Phase 2 contract and do not reopen lifecycle behavior.

### Medium — Client negotiation validation evidence remains incomplete

The explicit client validates returned capabilities in production code, but tests cover only an out-of-range selected revision, a server failure envelope, malformed JSON, and the normal default result. There is still no focused daemon fixture returning either a capability the client did not request or a result missing required `state-replay`. The package specifically requires the client to reject those impossible negotiated results and destroy the socket; add compact cases alongside the existing malformed-result table.

## Verification

The coder reports 39 focused tests and all 161 music-core/package checks passing. The frame-reader close/EOF behavior and newly added classifications are supported, but the acceptance evidence above remains missing.
