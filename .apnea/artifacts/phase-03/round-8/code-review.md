---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains within allowed paths. The scripted daemon now synchronizes request receipt and adds useful clean-EOF and stale-middle-revision evidence.

## Findings

### High — The scripted-daemon synchronization is not terminal/failure-safe

`received(count)` waits through callbacks stored in `receivedWaiters`, but those callbacks are never removed after waking. More importantly, socket close/error and helper disposal never reject outstanding `received()` calls. If the client fails to send an expected frame, a test blocks forever instead of entering `finally`. The helper also records only one accepted/closed Promise, so it cannot prove that no second connection was opened.

Use removable waiter entries that resolve once, reject all pending/future waits on terminal/close, and count or queue accepted connections. Ensure listener startup failure also closes the server/removes the path. This is required for deterministic failure-safe acceptance evidence.

### High — Terminal/disposal and stream/listener acceptance remain incomplete

The added clean-EOF test proves one pending command becomes indeterminate and a future call becomes connection-lost, but it does not assert one connection/no second hello or response/error/end/close race ordering. The suite still lacks:

- error/destroy/close races and once-only settlement across multiple in-flight commands;
- repeated disposal followed by late response/error/end/close, no listener/cache mutation, and exactly-once socket destruction;
- actual post-unsubscribe suppression (the state test still sends no frame after unsubscribe), self-unsubscription, and late subscriber immediate delivery;
- malformed nested active status/state, malformed NDJSON, partial EOF, and split/multiple-frame active and handoff delivery;
- reader/listener processing remaining usable for a later command after listener defects;
- preservation of structured `ProtocolError.details` on a request-local failure.

The helper now exposes most controls needed for these cases, but they are not used. Add compact focused scenarios from package sections 8–9 and assert connection/frame counts for no replay.

## Verification

The coder reports 10 client tests, 45 focused tests, 167 music-core tests, all package/build/typecheck/format targets, and the static scan passing. These support the new synchronized happy paths but do not complete the Phase 3 acceptance gate.
