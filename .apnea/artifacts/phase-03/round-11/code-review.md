---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains confined to the four allowed files. Round 11 adds useful disposal-first, split/multiple active-frame, status-listener, self-unsubscribe, and post-listener command evidence.

## Findings

### High — Terminal/disposal evidence still does not cover the required races and observations

The new disposal test checks pending/future codes, but it does not await the daemon's close signal, observe one destruction, or attach state/status listeners and prove late data cannot mutate caches or invoke them. Its response and error are issued only after synchronous disposal, rather than covering response/error/end/close orderings.

The loss suite also still has only one pending command and clean EOF. Add a compact deterministic scenario with multiple in-flight commands and error/end/close ordering, assert each settles once, await closure, and inspect captured frame/connection counts to prove neither replay nor a second connection occurred. Complete the disposal scenario with closure and late listener/cache assertions.

### High — Handshake and invalid-stream acceptance remains missing

The raw-write test exercises split/multiple frames only after `createMusicSessionClient()` has completed. It does not prove status/state preservation in the hello-to-active handoff. There is still no active malformed nested status/state, malformed NDJSON, or partial-EOF test proving one invalid-daemon terminal transition, indeterminate pending work, cleared listeners, and no malformed/late publication.

Add focused real-socket cases for the package's handoff and invalid-stream boundaries. Also verify late status subscription receives the accepted cached value and that no status/state callback runs after termination/disposal.

### Medium — Structured protocol details remain unverified

`MusicSessionClientError.details` is implemented but no public-boundary test sends a valid request-local failure containing structured details and asserts they are preserved while the connection remains usable. Add this assertion to the existing typed-failure test.

## Verification

The coder reports 13 client tests, 48 focused tests, 170 music-core tests, all requested build/typecheck/format/package targets, and the timing-pattern scan passing. These checks are green but do not cover the remaining package acceptance boundaries above.
