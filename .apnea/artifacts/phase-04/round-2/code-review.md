---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

## High

1. `packages/pi-music-dock/extensions/music-dock/index.ts:398-402` leaves `pendingSample` set when an authoritative snapshot arrives. If sample A is held, an invalidation queues a follow-up, and a snapshot then projects newer state, settling A starts the older queued request after the snapshot. That request captures the snapshot's current sequence and can apply stale provider state over the authoritative snapshot. This violates the package requirement that a direct snapshot invalidate every older sample request and cannot be overwritten by stale sampling. Cancel the queued follow-up when applying the snapshot, or preserve the pending request's pre-snapshot sequence so its result cannot project. Add the deterministic active-sample, invalidation, snapshot, and settlement regression.

## Medium

2. `packages/pi-music-dock/test/index.test.ts:567-569` checks old caller settlement only after `await dock.start()` has completed replacement initialization. Because the replacement sample resolves immediately, this test would still pass if disposal incorrectly delayed active or queued caller settlement until replacement setup or sampling finished. Hold the replacement initial sample, invoke reload without awaiting it, and prove all old active and queued promises settle before that sample and before reload completes, as required by the phase package.

## Review Notes

The phase package remains within the approved Phase 4 plan. Round 1's disposal ordering, held reconciliation, shortcut parity, and late command, event, poll, waveform, delay, and sample suppression are otherwise addressed. The targeted Pi controller test passes with 15 tests. The root Apnea Markdown formatting baseline is documented non-product evidence and does not affect this verdict.
