---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 2 package remains aligned with the approved plan, and the cumulative source diff remains within allowed paths. The round correctly fixes arbitrary legacy major/minor acceptance and adds non-negative numeric schema checks plus one current-client happy-path test.

## Findings

### High — The schema-owned contract remains incomplete

Most of the prior schema finding is unchanged:

- `ProtocolRangeSchema` still does not enforce `minRevision <= maxRevision`, and `NegotiatedProtocolSchema` does not enforce that `selectedRevision` lies in its range; both are checked later by manual helpers.
- `TransportRequestSchema` still permits seek without `positionMs` and non-seek actions with it. `TransportEnvelopeSchema`, a manual action list, and imperative branches duplicate those semantics in `decodeRequest()`.
- `ProtocolErrorSchema` still permits `INCOMPATIBLE_PROTOCOL` without details and permits every other code with incompatibility details.
- Success/failure schemas still accept the opposite known payload as an additive extra instead of rejecting contradictory envelopes.
- The server still calls the synchronous throwing `decodeRequest()` inside `try/catch`; the required Effect decoder for the Effect request path is absent.

The exported schemas therefore are not yet the single semantic contract required by acceptance. The protocol tests also do not exercise malformed nested state/track/device/status/error/response data, contradictory envelopes, additive fields, major mismatch, range endpoints, or missing required capability.

### High — Real-socket compatibility and isolation evidence is still absent

`session-server.test.ts` remains untouched. The new client test proves only a current client's selected revision and default capability list. Phase 2 still lacks the required real-socket evidence that:

- an actual legacy `1.0` peer and a current client share one daemon/provider and both receive replay plus a live update;
- a disjoint peer receives actionable structured ranges, closes alone, and leaves an existing healthy peer usable;
- a state-only peer negotiates successfully and transport is rejected before coordinator admission;
- missing replay, malformed/second hello, non-increasing IDs, invalid action/seek, oversized frames, and incomplete EOF remain connection-local under negotiation;
- malformed or out-of-offer hello results make the explicit client fail once and destroy its socket.

The reported 33 focused tests and package gates pass, but they still do not establish these acceptance checks.
