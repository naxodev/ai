---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 6 package remains aligned with the approved bounded fan-out plan. Round 2 stays within the allowed client/config/framing/server/test scope.

## Findings

### High — The paused-reader test does not prove command progress while the writer is blocked

The new test reaches real Node backpressure and proves the other twenty-three clients continue receiving state, but it overflows and closes the paused peer before sending its only healthy command. `healthy[0].play()` therefore proves recovery after local eviction, not that coordinator command work and global FIFO/results continue while the slow writer remains blocked, as required by package steps 7 and 9.

Likewise, `onStateCoalesced` is a server-global hook. Rapid emission to twenty-three healthy peers can increment `coalesced`, so `coalesced > 0` does not establish that the paused connection retained one latest state. Make backpressure/coalescing observations connection-identifiable (bounded metadata only), issue ordered commands from healthy clients while the slow writer is still waiting for drain, and prove their results before triggering the slow peer's mandatory overflow.

### High — The inbound chunk-queue overflow path remains untested

`inbound frame burst overflow closes only the abusive connection` exercises `maxFramesPerChunk`; it does not block one request and fill `inboundChunkQueueCapacity` through repeated data events. The queue-full `onData` branch is therefore still unproven, including its exact-once local diagnostic/finalization and healthy-peer continuity. Add the package's blocked-request chunk flood rather than treating frame-count overflow as evidence for both independent bounds.

There is also no focused provider-derived oversized outbound-frame case proving frame-size failure closes only that client while the selected graph and a healthy peer remain live.

### Medium — Cross-client FIFO admission is not deterministically ordered

The real command test starts `pause`, `next`, and `previous` on different sockets without waiting for each `onCommandAdmission` observation before issuing the next. Cross-socket delivery order is not guaranteed, so the expected provider order relies on local scheduling rather than the package's required known admission order. Gate each submission on its admission hook, then retain the existing `SERVER_BUSY`, accepted-settlement, and later-worker-recovery assertions.

### Medium — Remaining explicit acceptance is only inferred from baseline tests

The explicit-client bound test proves rejection and recovery, but no reconnect test uses a constrained pending limit to prove the wrapper remains queue-free and does not replay rejected/admitted work. The 24-client cleanup also checks the socket path and provider disposal but not bind-reservation/temporary debris. These are direct Phase 6 package checks and should be asserted in the focused slice.

## Resolved findings

Round 2 correctly validates `maxPendingRequests` before opening a socket, bounds frame accumulation during framing, retains all fulfilled 24-client startups before surfacing failures, asserts capability equality, reaches real write backpressure, adds mandatory-lane local overflow, and adds real `SERVER_BUSY` recovery evidence.

## Verification

The coder reports 4 focused tests, 133 combined server/client/coordinator tests, and a passing 240-test build/typecheck/test/format/package matrix with timer and diff checks. A disclosed pre-existing 20-caller timing flake passed isolated repetition and the immediate full rerun. The remaining findings concern incomplete Phase 6 acceptance, not a reported command failure.
