---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 6 package remains aligned with the approved bounded fan-out plan. Round 4 stays within its allowed server/test scope.

## Findings

### High — Required oversized outbound-frame containment is still absent and still crashes the runtime

Round 4 does not address the remaining Round 3 blocker. The coder result again reports that a provider-derived oversized-state real-socket test terminates Bun with `Trace/BPT trap`, so the test is omitted from the suite.

The package explicitly requires oversized provider status/state frames to close only the offending connection while the daemon, healthy peer, coordinator, and listener remain live. Repeatedly crashing the runtime while attempting that scenario is evidence that this safety property has not been established; the passing matrix excludes the exact case.

Run the acceptance through an isolated child process so a runtime crash is observable without killing the parent test runner, or create a stable selected-Layer boundary that reaches the production encode/local-close path. The test must prove:

- the oversized peer closes with one bounded diagnostic;
- a healthy peer still receives state and completes a command;
- the selected graph does not fail;
- child/process cleanup is bounded even if the runtime crashes.

If the fault is genuinely in Bun rather than this implementation, the gate still needs a stable regression fixture and an explicit supported behavior/mitigation; silently removing the crashing case cannot satisfy this phase.

## Resolved findings

Round 4 now exposes blocked/unblocked writer lifecycle for the identified socket and asserts that the slow writer remains blocked during healthy convergence and command settlement. It also adds the 24-client bind-reservation/temporary-residue assertion. Those changes resolve the remaining paused-reader and cleanup findings from Round 3.

## Verification

The coder reports 7 focused tests, 134 combined server/client/coordinator tests, and a passing 241-test build/typecheck/test/format/package matrix with timer and diff checks. The required oversized-frame scenario is not part of those passing results and remains a blocking Phase 6 acceptance gap.
