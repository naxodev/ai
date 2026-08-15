---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains limited to the four allowed files. Round 14 reports only a scripted-daemon typing/cleanup compatibility adjustment and does not add acceptance evidence for the prior blocking findings.

## Findings

### High — Invalid active-stream acceptance is still missing

There is still no focused real-socket case for active malformed nested status/state, malformed NDJSON, or buffered partial data at EOF. The package requires proof that these boundaries terminate once as invalid-daemon `CONNECTION_LOST`, reject pending work as `INDETERMINATE_COMMAND`, clear listeners, suppress malformed/late publication, and preserve the first result through later close/error callbacks.

Use the existing raw `write()`, `end()`, and `closed()` controls to add deterministic evidence.

### High — Network-loss and disposal race acceptance is still missing

The loss test still covers one pending command and clean EOF only. It neither awaits closure nor inspects the final captured client frames. Add multiple in-flight commands and error/end/close ordering, asserting once-only `INDETERMINATE_COMMAND`, future `CONNECTION_LOST`, one connection, and no replayed command frame.

The disposal-first test still does not observe closure/destruction or prove listener/cache suppression. Add listeners before disposal, dispose repeatedly, await the one close transition, deliver late response/data/error/end/close where possible, and assert pending/future calls remain `DISPOSED` with no cache or listener changes.

## Verification

The coder reports 49 focused tests and 171 music-core tests plus all requested build/typecheck/format/package targets and timing-pattern scan passing. This is regression evidence only; Round 14 provides no new evidence for the unresolved Phase 3 acceptance boundaries above.
