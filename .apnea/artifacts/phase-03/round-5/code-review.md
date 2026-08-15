---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains within allowed paths. Invalid/impossible hello failures now detach the retained handshake reader, and wrong-action success now has focused indeterminate/future-loss evidence.

## Findings

### High — The two-reader handoff remains instead of the required lifetime reader

The core Round 4 finding is unchanged. Hello success still executes `cleanup(true)`, removing handshake `error`/`end`/`close` while leaving one handshake `data` callback. After result validation, the code installs a second active callback set and only then removes handshake `data`. This is not one callback set routed through explicit handshaking/active/terminal state.

During validation, lifecycle events remain unowned. During overlap, both data callbacks can process the same re-entrant event through the same framer. Fixing failure-path detachment does not resolve either correctness boundary. Replace the handshake closure plus `Client.attach()` transfer with one socket-lifetime owner that transitions state before resolving readiness and detaches once on all terminal/dispose paths.

### High — Most acceptance tests remain absent

The existing reverse-order test now also covers one wrong-action result, but the suite still lacks focused evidence for:

- unsolicited and duplicate response isolation across later requests;
- malformed transport result and typed request-local failure followed by success;
- error/end/close races, no replay/second connection, and once-only settlement;
- repeated disposal, future `DISPOSED`, and late callback suppression;
- state instance/revision ordering;
- listener exception, self/unsubscribe, idempotent unsubscribe, and late subscription behavior;
- malformed nested active frames, split/multiple daemon frames, partial EOF, and gap-free handshake delivery.

There is still no reusable scripted-daemon seam with deterministic accepted/received/closed signals as required by the package. Add the remaining request-settlement and stream/listener tests rather than continuing to extend the single ad hoc scenario.

## Verification

The coder reports all 41 focused tests, 163 music-core tests, package/build/typecheck/format targets, and the static scan passing. These regressions support the new wrong-action behavior but do not satisfy the remaining Phase 3 gate.
