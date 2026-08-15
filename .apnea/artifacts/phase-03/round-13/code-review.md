---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains limited to the four allowed files. Round 13 adds focused evidence that an event appended to the negotiated hello write is retained as active status and replayed to a late subscriber.

## Findings

### High — Invalid active-stream behavior remains unverified

The new hello-tail test addresses the handoff gap, but there is still no active malformed nested status/state, malformed NDJSON, or partial-EOF scenario. The package requires deterministic evidence that invalid framing/schema:

- rejects pending commands once as `INDETERMINATE_COMMAND`;
- records non-retryable invalid-daemon `CONNECTION_LOST` for future calls;
- clears listeners without publishing malformed or late status/state;
- preserves that first terminal outcome through later error/close callbacks.

Add compact cases using the scripted daemon's raw `write()`, `end()`, and `closed()` controls.

### High — Network-loss and disposal race acceptance remains incomplete

The loss test still covers only one pending command and clean EOF, does not await daemon closure, and does not inspect captured frames to prove no command replay. Add multiple in-flight commands and an error/end/close ordering, assert each Promise settles exactly once, then assert future `CONNECTION_LOST`, one connection, and no extra client frame.

The disposal-first case still does not await the close transition or attach listeners before delivering late data. Complete it by proving repeated disposal produces one observed close/destruction and that late response/data/error/end/close cannot alter pending/future `DISPOSED`, mutate the caches, or invoke status/state listeners.

## Verification

The coder reports 14 client tests, 49 focused tests, 171 music-core tests, all requested build/typecheck/format/package targets, and the timing-pattern scan passing. These checks support the handoff addition but do not complete the remaining Phase 3 acceptance requirements above.
