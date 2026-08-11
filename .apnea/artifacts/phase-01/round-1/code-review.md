---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The phase package is aligned with approved Phase 1 and correctly excludes the coordinator and server findings assigned to later phases. The claimed product/test paths also match the package boundary.

## Findings

### Critical — A throwing source disposer loses the terminal and permanently stalls supervision

`system-media.ts:436-443` marks the attempt disposed and invokes `disposeSource()` before notifying the provider listener. If that external disposer throws, the invalidation callback is never invoked. Later cleanup cannot recover: `stop()` sees `disposed === true`, while `eventsFromAttemptAdapter` remains blocked waiting for a terminal and therefore never retries. This violates both terminal delivery and the tagged source-disposal boundary. Terminal notification and exact-once disposal must be arranged so a disposal failure cannot suppress invalidation or strand the supervisor.

### High — Tagged source errors are constructed and then discarded

`provider.ts:148-152` converts disposer failures to `ProviderError("dispose", ...)` and immediately catches them as `Effect.void`. Likewise, `provider.ts:219-227` catches startup `ProviderError("source", ...)` and replaces it with an untyped invalidation, losing the operation and original cause. The package requires source startup/disposal failures to cross one observable tagged boundary while supervision continues. The startup test at `system-media.test.ts:240-272` checks only invalidation/retry and never verifies the required `ProviderError` operation/cause.

### High — The production retry loop does not use or test the declared Schedule

The integrated supervisor at `provider.ts:216-235` implements separate recursive `Effect.sleep`/counter logic. `attemptRetrySchedule` is used only by its isolated test; production never uses it. Consequently, the full 1/2/4/8/8 and reset assertions at `system-media.test.ts:168-205` do not exercise `eventsFromAttemptAdapter`, while the integrated test at `:207-238` proves only the first 1- and 2-second retries and never proves the capped sequence or reset after a valid snapshot. This misses the plan/package requirement that the actual provider supervisor be Schedule-owned and deterministically verified end to end.

### High — Required provider-boundary and lifecycle evidence is absent

`serviceFromAdapter` is private and the production Layer hardcodes `createSystemMediaAdapter`, so the focused suite cannot exercise production service construction with instrumented acquisition/finalization. No added tests cover tagged adapter acquisition, status/probe, sample, unsupported transport, transport rejection, or source-disposal failures; nor do they prove provider Layer acquisition/finalization exactly once. The raw seam also lacks the required explicit-dispose-before-terminal case. The reported 37 focused passes and package gate therefore do not substantiate Phase 1's complete acceptance matrix.
