---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 2 package remains aligned with the approved plan, and the cumulative source diff remains confined to allowed paths. The client handshake leak, capability-option validation, incompatible-error constructor, replay assertions, and structured incompatibility assertions from the prior review are addressed.

## Findings

### High — The new frame reader cannot settle pending reads on close/EOF

`frameReader()` listens only for `data` and `error`. A normal socket `close` neither rejects pending `next()` calls nor invokes `framer.end()`. If a peer closes before the expected response—or sends an incomplete final frame—the test waits forever rather than failing and entering `finally`. This also prevents the helper from proving the package's incomplete-EOF behavior. Track terminal state, process `end`/`close` through `NdjsonFramer.end()`, reject all pending/future reads, and remove all listeners in `dispose()`.

### High — Required negotiated-boundary cases remain untested

The package explicitly requires compact real-socket coverage for malformed current hello range, missing required replay capability, second hello, non-increasing request IDs, post-hello invalid action/seek, oversized frame, and incomplete EOF. None of those cases was added. Existing tests cover a pre-hello unknown action and partial EOF from the old baseline, but they do not establish the complete post-negotiation policy or all stable response classifications.

The incompatibility socket test also exercises a different protocol major, not a same-major disjoint revision range, and does not assert that exactly one failure response was emitted before closure. Add the specified focused cases without reopening lifecycle behavior.

### Medium — Nested schema rejection evidence remains partial

The protocol tests now cover range, selected revision, transport, incompatible-error details, contradictory success, additive fields, and required replay. They still do not prove malformed nested state, track, device, provider status, failure response, or the contradictory failure-with-`data` branch required by the schema-focused package. These should decode through the public shared server-frame schemas/functions so the wire boundary—not only individual construction—is exercised.

## Verification

The coder reports 38 focused tests and all 160 music-core/package checks passing. That confirms the implemented happy paths and regressions, but the missing deterministic close handling and required boundary cases remain acceptance blockers.
