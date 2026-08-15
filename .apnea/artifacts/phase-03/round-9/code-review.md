---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative product/test diff remains confined to the four allowed files. Round 9 improves the scripted daemon, malformed-result evidence, unsubscribe evidence, and connection counting without broadening scope.

## Findings

### High — Disposal can overwrite an earlier terminal outcome and destroy the socket again

`Client.dispose()` guards only `#disposed`, not an already completed `#terminal` transition. After connection loss or invalid daemon data, calling `dispose()` changes future calls from the first recorded `CONNECTION_LOST` outcome to `DISPOSED` because `request()` checks `#disposed` first. It also calls `socket.destroy()` after `terminate()` may already have destroyed the socket. This violates package section 5's first-terminal-state rule and section 8's race/exactly-once destruction requirement.

Make disposal a no-op once another terminal transition has won, while retaining `DISPOSED` when disposal wins first. Add focused ordering evidence for loss/error/response versus repeated disposal, pending/future outcomes, and one destruction.

### High — Required terminal and stream/listener acceptance evidence is still missing

Round 9 adds only a clean `end()` case and does not use the helper's new `error()`, `destroy()`, raw `write()`, or `closed()` controls. The package still requires focused proof of:

- multiple in-flight commands settling once across error/end/close ordering, with no replayed frame or second connection;
- repeated disposal followed by late response/error/end/close, no cache/listener mutation, and exactly-once destruction;
- split and multiple frames across handshake/active handoff, malformed NDJSON, partial EOF, and malformed nested status/state;
- status listener behavior, self-unsubscription, listener isolation with subsequent command/reader activity, and no callbacks after termination/disposal;
- structured `ProtocolError.details` preservation at the public client boundary.

The state test now proves ordinary repeated unsubscribe and late state replay, but those additions do not cover the remaining package sections 8–9 scenarios.

## Verification

The coder reports 11 client tests, 46 focused tests, 168 music-core tests, all requested build/typecheck/format/package targets, and the static timing scan passing. The evidence is green but does not exercise the unresolved acceptance requirements above.
