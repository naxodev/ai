---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 6 package remains aligned with the approved bounded fan-out plan, and Round 3 stays within the allowed server/client/test scope.

## Findings

### High — Oversized outbound-frame containment remains unproven after crashing the runtime

The package explicitly requires provider-derived frames exceeding `maxFrameBytes` to close only the offending client without killing the daemon or disrupting a healthy peer. The coder result states that the attempted focused real-socket test caused a Bun segmentation fault and was removed. A known crashing acceptance scenario cannot be waived as residual platform risk, especially when this phase's purpose is to prove abusive/oversized traffic cannot kill the daemon.

Retain a stable regression boundary: isolate the scenario in a child process if necessary so a runtime crash becomes an asserted nonzero failure rather than taking down the test runner, or build a deterministic selected-Layer fixture that exercises the same encode/local-close path safely. Prove one oversized provider status/state is contained locally, the healthy peer still updates and executes a command, and the selected graph remains live.

### Medium — The paused-reader barrier does not establish that the writer is still blocked during healthy commands

The test now identifies coalescing/backpressure for the slow server socket and moves healthy commands before mandatory overflow. However, setting private `_writableState.highWaterMark = 1` guarantees `socket.write()` can return false even while the kernel immediately drains; `onWriteBackpressure` records entry only. The test has no observation that the writer is still awaiting `drain` when healthy state/commands complete. A paused reader plus historical `write(false)` is not necessarily the package's “while the slow writer remains blocked” condition on every platform.

Expose a bounded blocked/drained lifecycle hook or gate the drain wait in the test seam, then assert healthy convergence and ordered command results while that specific writer is currently blocked. Avoid relying solely on a private Node high-water-mark mutation.

### Medium — The 24-client cleanup still omits required artifact assertions

The main 24-client test now safely retains all fulfilled startups and proves shared capabilities/ownership/fan-out, but final cleanup checks only provider counters and socket-path absence. It still does not assert bind-reservation/temporary names (or managed marker debris if using a managed secure runtime) are absent as required by the package.

## Resolved findings

Round 3 adds connection-identifiable backpressure/coalescing observations, a real blocked-request inbound chunk-queue overflow case, deterministic cross-socket admission ordering, healthy command execution before slow-peer eviction, and constrained reconnect no-replay coverage. The prior validation, framing, and all-settled cleanup fixes remain intact.

## Verification

The coder reports 7 focused tests, 134 combined server/client/coordinator tests, and a passing 241-test build/typecheck/test/format/package rerun with timer and diff checks. The first full run again hit the disclosed 20-caller baseline timing flake. The removed crashing oversized-frame case leaves an explicit Phase 6 acceptance check unresolved.
