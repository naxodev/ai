---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains confined to the four allowed files. Round 12 correctly adds public-boundary evidence that structured protocol details survive a request-local failure while the connection remains usable.

## Findings

### High — Terminal and disposal acceptance remains incomplete

Round 12 does not address the remaining section 8 gaps. The suite still needs deterministic proof that multiple in-flight commands settle exactly once across transport error/end/close ordering, followed by `CONNECTION_LOST` for future calls. It must await daemon closure and inspect captured connection/frame counts so the daemon observes no replay and no second connection.

The disposal-first case still does not await closure or verify listener/cache suppression after late data. Complete it by observing the one close/destruction transition and proving late response/data/error/end/close cannot change pending/future `DISPOSED` outcomes or publish status/state.

### High — Handshake handoff and invalid active streams remain unverified

The existing split/multiple-frame case runs only after client creation. There is still no evidence that status/state frames in the hello chunk or immediately after hello survive the handshake-to-active transition. There is also no active malformed nested status/state, malformed NDJSON, or partial-EOF scenario asserting:

- pending work becomes `INDETERMINATE_COMMAND`;
- future work sees the non-retryable invalid-daemon `CONNECTION_LOST`;
- listeners are cleared and malformed/late data is never published;
- subsequent close/error callbacks do not replace the first terminal result.

Add compact real-socket cases using the scripted daemon's raw-write/end/error/closed controls. Include late status replay, since only late state replay is currently covered.

## Verification

The coder reports 13 client tests, 48 focused tests, 170 music-core tests, all requested build/typecheck/format/package targets, and the timing-pattern scan passing. These checks support the details change but do not complete the remaining Phase 3 acceptance boundaries.
