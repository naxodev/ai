---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan. The cumulative diff is still limited to the four allowed files, and Round 10 correctly prevents disposal from replacing an earlier terminal outcome.

## Findings

### High — The package's terminal/disposal acceptance matrix remains unverified

The clean-EOF test now calls `dispose()` after loss and preserves `CONNECTION_LOST`, but it still covers only one pending command and one ordering. The scripted daemon's `error()`, `destroy()`, and `closed()` controls remain unused. There is still no focused proof that:

- multiple in-flight commands settle once across error/end/close ordering;
- the daemon receives no replayed frame as well as no second connection;
- disposal wins when invoked first, remains idempotent, closes/destroys once, and ignores late response/error/end/close without changing pending/future results or listener/cache state.

These are explicit package sections 5 and 8 acceptance requirements, not optional expansion.

### High — Framing/handoff and remaining listener contract evidence is still absent

The suite still does not exercise the helper's raw `write()` seam. Add focused coverage for split and multiple frames around hello-to-active handoff, malformed NDJSON, partial EOF, and malformed nested status/state, asserting one terminal transition and no malformed/late publication. It also still lacks status listener behavior, self-unsubscription, callbacks suppressed after termination/disposal, and public preservation of structured `ProtocolError.details`.

The existing state test proves thrown-listener isolation, ordinary repeated unsubscribe, ordered state authority, and late state replay, but it does not satisfy these remaining package section 9 checks.

## Verification

The coder reports 11 client tests, 46 focused tests, 168 music-core tests, all requested build/typecheck/format/package targets, and the timing-pattern scan passing. The implementation fix is supported, but the reported suite still does not cover the unresolved acceptance requirements above.
