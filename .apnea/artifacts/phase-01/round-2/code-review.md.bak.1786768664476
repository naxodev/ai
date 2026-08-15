---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The package remains aligned with approved Phase 1, and no additional product changes were made in this dispatch. The prior provider-boundary findings are addressed, but the later cold-stream ownership finding remains unresolved.

## Findings

### High — One provider Layer can still create multiple active raw attempts

`eventsFromAttemptAdapter` still returns a cold `Stream.callback` (`provider.ts:118-124`), and `serviceFromAdapter` still exposes that stream directly as `SessionProvider.events` (`provider.ts:310-318`). Each materialization runs a new supervisor with independent queues/retry state and calls `backend.subscribeAttempt` again. Two consumers of the same Layer-provided service can therefore create two concurrent `media-control stream` attempts against one adapter.

This violates the package's “there can be only one active attempt” and “one provider Layer acquisition … at most one active raw source attempt” acceptance invariants. The focused lifecycle test still consumes `provider.events` only once (`system-media.test.ts:428`), so the claimed 41 focused passes do not cover this case. The Layer must own one shared supervised event bridge (or otherwise enforce one materialization), with deterministic evidence that multiple subscribers do not duplicate source acquisition and that Layer shutdown finalizes the single source exactly once.
