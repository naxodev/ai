---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 2 package is aligned with the approved plan: it remains an explicit-path, schema/negotiation slice and keeps discovery, process lifecycle, reconnect, load hardening, artwork, hosts, manifests, and documentation out of scope. The product diff is confined to allowed paths.

## Findings

### High — Legacy protocol values are ignored during negotiation

`negotiateHello()` maps every decoded legacy hello through `legacyRange()`, which always returns the constants from `LEGACY_PROTOCOL`. Because `LegacyProtocolSchema` accepts arbitrary integer `major` and `minor` values, a peer advertising legacy `{ major: 2, minor: 99 }` is silently treated as `{ major: 1, minor: 0 }` and can negotiate successfully. Major/range incompatibility is therefore not enforced for the legacy wire shape. Make the legacy schema literal `1.0`, or normalize the decoded values and reject anything other than the supported preceding revision.

### High — The schema-owned contract is still partly manual

Several required semantic invariants are not represented by the exported schemas:

- `ProtocolRangeSchema` permits negative/reversed ranges; range validity is checked later by `validRange()`.
- `TransportRequestSchema` permits seek without `positionMs` and non-seek actions with it; `decodeRequest()` repeats action/position logic through `TransportEnvelopeSchema` and manual branches.
- Numeric non-negativity is checked after decoding for requests/state/responses rather than in the schemas themselves.
- `ProtocolErrorSchema` permits `INCOMPATIBLE_PROTOCOL` without range details and permits unrelated error codes with those details.
- Success/failure response schemas tolerate the opposite known payload as an extra field, despite the package requiring contradictory envelopes to be rejected.

The server also retains synchronous `decodeRequest()` plus `try/catch` instead of the package's Effect-based unknown decoder for its Effect request path. As a result, schemas are not yet the single semantic wire definition required by the acceptance gate.

### High — Required real-socket and explicit-client acceptance evidence is absent

Neither `session-server.test.ts` nor `session-client.test.ts` changed. The client suite still contains only the pre-existing empty-socket-path test, and the server suite has no legacy/current negotiation scenarios. Consequently there is no evidence that:

- a real legacy `1.0` peer and current client share one daemon/provider and both receive replay/live updates;
- a disjoint peer gets structured incompatibility and closes without disturbing a healthy peer;
- a state-only peer is admitted but transport is rejected before coordinator admission;
- malformed/second hello, increasing IDs, action/seek, oversize, and incomplete EOF remain correct under the negotiated boundary;
- the explicit client exposes valid selected revision/capabilities and destroys its socket on malformed or impossible hello results.

The reported 32 focused tests and package gates pass, but they do not exercise these Phase 2 acceptance checks.
