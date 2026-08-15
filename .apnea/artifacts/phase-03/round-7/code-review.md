---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains confined to allowed paths. The new tests add useful evidence for unsolicited/duplicate response isolation, request-local failure, basic disposal, state filtering, and listener exception isolation.

## Findings

### High — The scripted daemon does not provide the required deterministic controls

`startScriptedDaemon()` exposes only `send()`, `end()`, and `close()`. It does not expose accepted/received/closed signals, split/multiple raw writes, socket error/destroy controls, or a way to await a particular captured client frame. `send()` silently does nothing when no socket exists. As a result, tests send responses immediately after calling client methods without synchronizing on daemon receipt, and the helper cannot drive the required loss, framing, handoff, or late-callback races.

Extend the in-file seam as specified: retain the accepted socket, provide deterministic frame-received waits/queues and close observation, support complete/split/multiple raw daemon writes plus end/error/destroy, and make startup/cleanup failure-safe.

### High — Several Phase 3 acceptance checks remain unproved

The suite now has nine client tests, but still lacks focused evidence for:

- malformed transport success data (wrong action alone is covered);
- network error/end/close races, once-only indeterminate settlement, future connection loss, and no replay/second connection;
- disposal followed by late response/error/end/close callbacks and exactly-once socket destruction;
- a higher accepted state followed by an out-of-order middle revision;
- actual post-unsubscribe delivery suppression, self-unsubscription, late subscriber immediate replay, and listener processing remaining live for later commands/status;
- malformed nested active status/state, malformed NDJSON, partial EOF, split/multiple daemon frames, and explicit gap-free handoff behavior.

The disposal test unsubscribes twice but sends no later frame, so its unchanged-array assertion does not prove unsubscription. Add the remaining package section 8–9 scenarios using the strengthened deterministic seam.

## Verification

The coder reports 9 client tests, 44 focused protocol/client/server tests, 166 music-core tests, all package/build/typecheck/format targets, and the static scan passing. These support the scenarios added this round but do not complete the Phase 3 gate.
