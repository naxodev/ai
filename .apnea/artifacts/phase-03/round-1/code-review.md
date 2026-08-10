---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

## High

1. `packages/opencode-music-player/index.tsx:276-291` defers backend invocation to a microtask after marking the intent active, but that invocation does not recheck lifecycle state. If a caller enqueues a command and immediately calls `dispose()`, disposal resolves the caller while the deferred callback still invokes the backend. This violates the package requirement that disposal starts no queued backend command and that post-disposal continuations cannot start work.

## Medium

1. `packages/opencode-music-player/index.tsx:281-286,347-360` captures and queues a pause even when `backend.pause` is absent. The non-null assertion then throws, producing transport error state and a toast. Unsupported operations must resolve immediately without entering the queue or invoking the backend.

2. `packages/opencode-music-player/index.tsx:161-171,410-423` resolves active and queued callers during disposal but leaves `session.loading` unchanged. Because disposal marks the controller inactive before settlement and `updateLoading()` returns for inactive controllers, disposing during command work leaves loading stuck at `true`, contrary to the cancellation and loading contracts.

3. `packages/opencode-music-player/index.tsx:220-224,311-317,327-343` can retain an error from a failed command after a later, already-queued command succeeds. The later command cleared errors when it was originally enqueued, before the first command failed; its success does not clear `errorFromTransport`, and subsequent sampled reconciliation preserves the stale error indefinitely for polling-only backends. The failure presentation is therefore not scoped to the failed command.

4. The required deterministic coverage is incomplete. `packages/opencode-music-player/tests/controller.test.ts:231-258` uses immediately resolving commands and does not prove serialization. There are no regressions for adjacent pending seek coalescing and settlement of every caller, seeks separated by a discrete intent, failure followed by queued-command continuation, or fire-and-forget rejection safety. `packages/opencode-music-player/tests/controller-lifecycle.test.ts:161-199` does not cover queued cancellation, immediate in-flight caller settlement, late rejection suppression, post-disposal backend call counts, or loading cleanup. The stream recovery test at `packages/opencode-music-player/tests/controller.test.ts:218-229` also does not advance the recovery deadline to prove it re-enters the single-flight sampling lane.
