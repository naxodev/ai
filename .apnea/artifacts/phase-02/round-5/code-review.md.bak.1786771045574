---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The package remains aligned with the approved Phase 2 plan and changes remain within its coordinator seam. The new atomic sampling-transition and reserve-to-attach tests resolve the prior trigger and stale-deadline evidence gaps. The focused checks are reproducible (23 coordinator tests and 42 provider tests pass), but one mandatory concurrency gate remains.

## Findings

### High — Command tests still do not establish admission before release or closure

The saturation test forks both competing submissions and immediately releases the active transport (`session-coordinator.test.ts:535-543`); the queued-close test likewise forks both and immediately closes the coordinator scope (`:583-591`). Since neither waits for either submission to cross the lifecycle/queue admission boundary, the observed `SERVER_BUSY` result can occur only after the active job has been released, and the two `DISPOSED` results can come from submissions that first inspect lifecycle after closure. The tests therefore still do not reproduce the package-required queue-capacity boundary or close-versus-enrollment/offer race.

Keep the transport blocked and await the first completed competing result, which must be `SERVER_BUSY` and thereby proves the other caller is enrolled, before releasing transport or closing the scope. Then assert the enrolled caller's FIFO execution or `DISPOSED` settlement. This can be done with test-side Effect queues/deferred results and does not require a production test hook.
