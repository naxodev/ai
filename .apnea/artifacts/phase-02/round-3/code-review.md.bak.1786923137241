---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 2 package remains aligned with the approved plan, and the cumulative source diff remains confined to allowed protocol/client/server paths. The round substantially improves schema-level invariants and moves the server onto the shared Effect decoder.

## Findings

### High — Client hello failures can leave the socket open

`createMusicSessionClient()` destroys the socket only after a successful response whose hello result is later found impossible. During the handshake itself, both the `!frame.ok` branch and `fail("invalid hello response")` clean up listeners and reject without destroying the socket. This is observable for a client offering no `state-replay`: the server sends `UNSUPPORTED_CAPABILITY` and intentionally keeps the unnegotiated connection open, so the rejected client leaks that socket. A malformed daemon frame can do the same. The package explicitly requires every incompatible/malformed/semantically impossible hello to destroy the socket and fail once. Ensure all handshake rejection paths terminate it, and cover at least a server failure response plus malformed frame in the client tests.

### High — Real-socket evidence is incomplete and uses TCP-chunk assumptions

The new compatibility scenarios cover useful happy paths, but `nextFrames()` treats the first `data` event as one or more complete NDJSON frames. Unix/TCP streams may split a JSON line or coalesce hello and replay writes arbitrarily; the helper will either parse a partial line or consume/discard replay frames. Use the shared `NdjsonFramer` or an equivalent persistent buffered reader.

Related acceptance gaps remain:

- The legacy/current test asserts hello and a later live state, but does not assert initial replay for both peers; replay may already have been discarded by `nextFrames()`.
- The incompatibility test checks only daemon details. It does not assert the offered client range, actionable message, exactly one response, or that the incompatible socket actually closes.
- No real-socket cases cover missing replay, malformed current hello, second hello, non-increasing IDs, post-hello invalid action/seek, oversized input, or incomplete EOF as required by the phase package.

The reported passing suite therefore does not yet establish the complete negotiated boundary or deterministic connection-local behavior.

### Medium — Some schema-facing constructors/options can still create invalid wire state

`ProtocolErrorSchema` now correctly requires details for incompatibility, but `protocolError("INCOMPATIBLE_PROTOCOL", ...)` can still construct a value that fails that schema. Restrict that helper so incompatibility must go through the details-bearing constructor. Also validate the optional client `capabilities` override before connecting, as required alongside `protocolRange`; currently non-string runtime input is written to the socket and rejected only after connection.

## Verification

The coder reports 37 focused tests and all 159 music-core/package checks passing. Those successful paths are useful regression evidence, but they do not address the leak and stream-framing/coverage findings above.
