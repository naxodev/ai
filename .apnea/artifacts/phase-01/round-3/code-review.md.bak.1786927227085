---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The package remains aligned with approved Phase 1, and the cumulative product diff remains confined to its three allowed files. The executable cleanup-failure and real production closing-refusal implementations are in scope and have focused passing evidence.

## Findings

### High — Two failure paths can still deadlock before cleanup runs

The round improves whole-file ownership substantially, but acceptance check 3 is not yet complete:

- In `scoped signal wait removes both handlers after a signal`, `finally` emits only `SIGTERM` and then awaits the original `waiting` promise. If the intermediate SIGTERM listener-count assertion fails because that listener was not registered while SIGINT remains registered, the cleanup signal cannot settle the wait and `finally` hangs. Own the wait with an interruptible scope/fiber (as in the interruption test) so cleanup does not depend on the behavior being asserted.
- In `production closing refusal destroys a real listener connection`, `clientClosed` now rejects on `error`, but it is awaited only after `Latch.await(refused)`. If connection setup errors before the production callback opens `refused`, the rejection is never observed, the test remains blocked on the latch, and `finally` never releases `releaseClosing`. Race/coordinate the connection outcome with callback observation, or use a Node-callback barrier that can fail immediately without waiting forever.

These are precisely setup/assertion-failure resource paths covered by the package; fixing them does not add lifecycle acceptance scope.

## Verification

The coder reports 2 focused tests, all 25 server tests, 65 baseline tests, all music-core targets, and the static scan passing. The successful-path evidence supports acceptance checks 1 and 2, but cannot prove the two failure paths above unwind safely.
