---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 6 package remains aligned with the approved bounded fan-out plan. Round 5 adds only an allowed server-test fixture.

## Findings

### High — The isolated oversized-frame fixture bypasses the healthy server peer required for local-containment proof

The child successfully contains the oversized target and then calls `server.coordinator.submit("play")` directly. That bypasses the listener, connection scope, bounded writer, protocol response, and explicit-client settlement paths. It proves the coordinator object remains callable, but not that the oversized frame failure is local to one connection or that the selected server still serves a healthy peer, which was the explicit outstanding acceptance.

A healthy peer can still be tested despite the server-global frame limit: negotiate a transport-capable peer without `state-replay`, or restore a bounded provider snapshot and connect/use a fresh healthy state peer after the target closes. Send its command through `MusicSessionClient` and require its protocol result; also assert the listener/socket remains present until normal close. This is necessary to establish that the local close did not poison server connection handling.

### Medium — Child cleanup is not bounded on the failure path

The parent wraps `child.exited` in a timeout, but its `finally` only calls `child.kill()` and does not await the post-kill exit. If the child hangs—the exact reason for subprocess isolation—the test can return while the process and its random socket remain alive. The successful child also does not assert removal of its socket/bind artifacts after `server.close()`. Kill and await the child failure-safely, consume/close its streams, and have the child assert its selected runtime artifacts are gone before status zero.

## Resolved findings

The subprocess boundary prevents the previously observed Bun crash from terminating the parent runner and now exercises the real selected encode/local-close path with one bounded overflow observation. Round 4's blocked-writer and 24-client residue fixes remain intact.

## Verification

The coder reports 6 focused tests, 135 combined server/client/coordinator tests, and a passing 242-test build/typecheck/test/format/package matrix with timer and diff checks. The new child exits zero in the reported run, but its assertions do not yet prove healthy-peer continuity or bounded cleanup after a hung/crashing child.
