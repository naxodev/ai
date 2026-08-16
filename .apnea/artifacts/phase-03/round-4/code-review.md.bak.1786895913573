---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains within allowed client/protocol/test paths. Invalid seek is now exercised through the real request fixture, but the core lifetime and evidence requirements remain incomplete.

## Findings

### High — Overlapping two reader sets is not the required lifetime state machine

Attaching the active reader before `handshake.detach()` avoids a normal detach-first window, but it still leaves two independent `data` callbacks rather than one callback routed by handshaking/active state. During the overlap, a re-entrant data event can be fed twice into the same `NdjsonFramer` and processed/queued twice. More importantly, handshake still removes `error`, `end`, and `close` immediately at hello success, leaving lifecycle events unowned throughout result validation until active attachment.

There is also a cleanup leak on invalid/impossible hello results: `cleanup(true)` retained handshake `onData`, but the later validation catch/branch destroys the socket and throws before calling `handshake.detach()`. The retained callback is never removed. Implement the package's single exact callback set and state transition instead of transferring between closures; every handshake failure, terminal path, and disposal must detach that same set once.

### High — The required acceptance tests remain missing

The only new assertion is local invalid-seek rejection within the reverse-order test. The suite still has no deterministic coverage for unsolicited/duplicate responses, malformed or wrong-action success, request-local typed failure, loss races/no replay, repeated disposal/late callbacks, state authority, listener isolation and subscription behavior, malformed nested active frames, split/multiple daemon frames, partial EOF, or gap-free handoff.

The test file still lacks the package-required reusable scripted-daemon seam capable of sending those events and exposing deterministic receive/close signals. Add the focused request-settlement and stream/listener tests from package sections 7–9 with failure-safe ownership.

## Verification

The coder reports all 41 focused tests, 163 music-core tests, package/build/typecheck/format targets, and the static scan passing. The unchanged test count confirms the broad Phase 3 acceptance matrix is still unsupported.
