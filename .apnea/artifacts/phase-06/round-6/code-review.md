---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 6 package remains aligned with the approved bounded fan-out plan. Round 6 changes only the allowed server test.

## Findings

### High — Oversized-frame containment still lacks a healthy protocol peer

Round 6 hardens subprocess cleanup but does not address the blocking Round 5 acceptance. The child still calls `server.coordinator.submit("play")` directly after closing the oversized target. That bypasses the Unix listener, connection ownership, bounded outbound writer, protocol response, and explicit-client settlement paths. The coder result explicitly acknowledges that fresh healthy-client state/command behavior remains unproven.

The reported stale state-replay difficulty does not require sleeps or polling to solve. Negotiate a healthy explicit client with `capabilities: ["transport"]` before emitting the oversized state (or after target closure). It will not subscribe to the oversized state stream, but its command still traverses the real listener → connection → coordinator → mandatory writer → explicit-client response path. Require that command to settle successfully while the server socket remains live. If later state-replay recovery is also desired, use an Effect hook/latch or coordinator observation rather than weakening the required healthy-peer proof.

Until a healthy socket client survives and completes protocol work, the fixture establishes only that one client closed and an internal coordinator object remained callable—not that the frame failure was isolated across the selected server.

## Resolved findings

The subprocess now consumes stderr concurrently, kills and awaits a timed-out child, and asserts socket/bind artifact cleanup. This resolves the Round 5 failure-path cleanup finding. The oversized payload margin and exact single-overflow assertion are also retained.

## Verification

The coder reports the isolated oversized test passing, 5 focused fan-out/backpressure/overflow tests passing, 135 combined tests, and a passing 242-test build/typecheck/test/format/package matrix with timer and diff checks. The coder's residual-risk statement confirms the remaining healthy-peer Phase 6 acceptance is outside those assertions.
