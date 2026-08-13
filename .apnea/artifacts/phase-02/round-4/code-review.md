---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The package remains aligned with the approved Phase 2 plan and the changes stay within the coordinator seam. The claimed focused checks are reproducible (21 coordinator tests and 42 provider tests pass), but the three required concurrency interleavings still lack deterministic acceptance evidence.

## Findings

### High — Event acknowledgement still precedes coordinator claim

The fixture now uses `Stream.flatMap`, but it offers to `eventConsumed` before emitting the event downstream (`provider.ts:509-512`). Consequently, `invalidation()` can resume after `Queue.take(eventConsumed)` while the coordinator's `Stream.runForEach` callback has not yet executed `claimSample`. Releasing the blocked sample after that acknowledgement remains scheduler-dependent and does not prove the active generation was invalidated before publication. Synchronize on coordinator claim itself, or directly test the atomic sampling transition without coupling the production service to fixture controls.

### High — Command boundary tests still close/release before proving enrollment

Both the saturation test and queued-close test fork the competing submissions and immediately release the active transport or close the scope (`session-coordinator.test.ts:514-522`, `:559-568`). The stronger `SERVER_BUSY` and `DISPOSED` assertions identify outcomes, but they do not prove that one caller occupied the configured queue while another crossed the overflow boundary, nor that close raced an enrolled queued caller rather than submissions that first ran after closure. Keep the transport blocked and await the overflow result (which proves the other competing caller enrolled) before release/close, then verify queued settlement and FIFO continuation.

### High — Poll test covers reservation ordering, not stale installation

`stale poll-deadline reservation cannot replace newer authority` initializes an already-newer revision and invokes `reservePollDeadline` sequentially with no fibers. It verifies the comparison branch, but not the required interleaving where an older `restartPoll` candidate is delayed while a newer revision installs its deadline, after which the older candidate must fail attachment/interrupt itself without replacing the newer fiber. Add deterministic coverage of the reserve-to-attach race and assert the newer installed deadline remains the sole live deadline.
