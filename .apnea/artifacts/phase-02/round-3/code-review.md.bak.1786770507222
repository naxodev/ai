---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The package remains aligned with approved Phase 2, production test-fixture coupling has been removed, and most required matrices now have focused coverage. Two concurrency gates remain non-deterministic or indirect.

## Findings

### High — Invalidation tests still do not synchronize with coordinator claim

Splitting `claimSample` from `runSample` makes the production event handler safer, but the fixture's `eventConsumed` remains an upstream `Stream.tap` signal. The `invalidation` helper can return before the downstream coordinator handler invokes `claimSample`, so the burst test may still release the blocked provider sample before its generation is invalidated. A passing run therefore does not deterministically reproduce the trigger-versus-publication race required by the package. Add a coordinator-observable claim/second-start condition without coupling production code to the fixture, and assert the stale state never publishes.

### High — Command admission and close tests do not prove enrollment deterministically

The saturation test forks two concurrent submissions and immediately releases the active transport (`session-coordinator.test.ts:514-522`); the close test similarly forks two submissions and immediately closes the scope (`:556-565`). Neither waits for a queue/admission signal. Thus the outcomes can result from submissions running only after release/closure rather than from one enrolled queued job plus one overflow at the intended boundary. The tests also assert only generic `Failure`, not `SERVER_BUSY` for overflow and `DISPOSED` for the queued caller. Explicitly synchronize enrollment/offer, assert stable codes and exact-once settlement, then prove FIFO continuation.

### High — The stale poll-installation race still lacks direct evidence

The revised reservation-before-sleeper algorithm appears designed to reject stale candidates, but the new test only publishes paused then playing states sequentially and observes their public deadlines. It does not reproduce an older `restartPoll` paused between reading its snapshot and reserving/attaching its sleeper, which the package explicitly requires. Add deterministic evidence for that interleaving (for example by factoring and testing the deadline reservation transition) and prove the stale candidate is interrupted while the newer deadline remains installed.
