---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The phase package is aligned with approved Phase 2 and correctly excludes socket/server behavior. The implementation stays within the allowed coordinator/provider-test seam, but the phase acceptance gate is substantially incomplete.

## Findings

### High — The required deterministic acceptance matrix is largely absent

The focused suite contains only five tests, and the coder result explicitly acknowledges that the broader race/closure/config matrix remains unfinished. Missing direct evidence includes invalidation coalescing and maximum sample concurrency; pre-trigger/pre-snapshot/pre-command stale rejection; blocked-transport snapshot races for play, pause, and seek; poll boundary/reset/stale-install behavior; transport versus navigation reconciliation; provider failure recovery; queue saturation; multi-submitter FIFO; and every enrollment, blocked-work, queued-work, reconciliation, and late-completion closure race. The existing seek test publishes its snapshot before submitting an unblocked command, so it does not reproduce the race this phase was created to prevent. Passing these five tests cannot substantiate the package's acceptance checks.

### High — The Effect-native fixture cannot drive the required scenarios

`CoordinatorProviderFixture` (`provider.ts:409-433`) exposes one permanently opening `sampleStarted` latch, one sample gate, aggregate sample count, calls, subscriptions, and finalizations. It has no per-call sample/transport start controls, transport blocker, next sample/transport failure, null sample, active/max-concurrency or interruption counters, completed sample counter, or source-finalization counter. Consequently, deterministic testing of the package's sampling, command-failure, and closure invariants is impossible with this fixture. The tests instead use `Effect.yieldNow` at `session-coordinator.test.ts:80,131,157`, contrary to the package's explicit synchronization requirement.

### High — No-op sampled states still advance authority

`coordinator.ts:132-149` increments the revision whenever `mergePlayer` returns a state. It does not detect that the merged state is unchanged, so an identical sampled state is accepted as a new authority revision and resets polling. This contradicts the package invariant that a no-op/invalid merge must not increment revision, and can create needless revision churn from unchanged polls.

### High — Config acceptance is not covered

The sole config test checks defaults and an empty socket path. It does not exercise concrete overrides, `ConfigProvider` parity/defaulting, malformed numeric text, or invalid frame, capacity, reconciliation, and poll values as required. No Phase 2 config implementation or focused evidence was added to close that portion of the package.
