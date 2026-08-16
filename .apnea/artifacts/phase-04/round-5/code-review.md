---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan, and Round 5 remains within its allowed client/test scope. The reservation-to-adoption ownership gap from Round 4 is now closed by an interruptible acquisition followed by an uninterruptible reservation, with deterministic race evidence.

## Findings

### High — The Ref conversion does not make lifecycle transitions atomic

`ManagedLifecycleState` is now stored in a `Ref`, but the implementation still performs each transition as separate unsafe reads and single-property updates. For example, adoption checks `disposed`, `token`, and `pending` through separate getters, then clears `pending` and later installs `active` through separate `Ref.update` calls (`packages/music-core/session/client.ts:1284-1298`). Shutdown likewise reads and updates disposed/token/active/pending across multiple operations (`client.ts:1325-1334`). Token increment is a separate `getUnsafe` plus update, not one `Ref.modify`.

The listener sets are mutable `Set` objects stored inside the Ref and are changed directly with `.add`, `.delete`, and `.clear` (`client.ts:1239-1263`, `1338-1340`), bypassing Ref synchronization entirely. Disposal ownership fields (`#interrupt`, `#closeScope`, and `#dispose`) also remain ordinary mutable fields, so reentrant or concurrent `dispose()` calls are not reserved through the synchronized lifecycle state before scope closure begins.

This does not meet the package requirement that mutable lifecycle and generation/live checks be atomic under Effect synchronization; it wraps the old field mutations in a Ref without defining atomic transitions. Use `Ref.modify`/`getAndUpdate` operations that validate and update the complete ownership state in one step, keep listener/disposal ownership under the same synchronization policy (or an equivalent semaphore/latch), and perform notifications/releases from the transition result outside the atomic update.

### Medium — The full-target verification transcript appears stale

Round 4 reported 225 full tests and 950 expectations. Round 5 adds one test with three assertions, and the direct combined command correctly rises from 95 to 96 tests, but the claimed `nx run-many ... test` output remains exactly 225 tests and 950 expectations. That output therefore does not demonstrate that the latest tree ran through the required full target. Supply fresh full-target evidence (for example, bypassing a stale cache) before approval.

## Verification

The focused suite reports 11 passing tests, the direct client/server run reports 96 passing tests, and typecheck reports success. The ownership-race test covers the prior Critical finding; the remaining issue is the package's required atomic lifecycle synchronization and fresh full-target evidence.
