---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains confined to allowed client/protocol/test paths. Stable listener snapshots, connect-listener cleanup, handshake EOF handling, and use of the shared framer in the one new request test address parts of the prior review.

## Findings

### High — The required single lifetime reader/state machine is still absent

The implementation still has separate handshake and active listener sets. On hello success, `cleanup(true)` immediately removes handshake `error`, `end`, and `close` handlers while retaining only `data`. Later, after the handshake Promise resumes and validates the result, it calls `handshake.detach()` **before** constructing/attaching the active client callbacks. Thus the code still performs the exact detach-then-attach handoff the package prohibits, rather than transitioning one owned reader from `handshaking` to `active` before readiness.

This also leaves post-hello pre-attach `end`/`error`/`close` without an owner, and the retained handshake data callback has `done === true`, so its `fail()` path ignores framing/schema failures during that interval. Replace both sets with one socket-lifetime callback set and explicit handshaking/active/terminal state; the same callbacks must validate hello, route queued frames, finalize EOF, and later detach on terminal/dispose.

### High — Phase 3 acceptance evidence is still almost entirely missing

No tests were added this round. The suite still lacks the package-required deterministic evidence for unsolicited/duplicate responses, malformed or wrong-action results, request-local typed failures, loss races and no replay, repeated disposal and late callbacks, invalid-seek no-write behavior, state instance/revision authority, listener isolation/unsubscription/late subscription, malformed nested frames, split/multiple daemon frames, partial EOF, and gap-free handshake delivery.

Switching the reverse-order test's request parser to `NdjsonFramer` does not provide the required reusable scripted-daemon seam or any of those scenarios. Add the focused tests from package sections 7–9 with failure-safe socket/server ownership.

## Verification

The coder reports all 41 focused tests, 163 music-core tests, package/build/typecheck/format targets, and the static scan passing. These are valid regressions, but the unchanged test count and remaining two-listener handoff do not satisfy the Phase 3 acceptance gate.
