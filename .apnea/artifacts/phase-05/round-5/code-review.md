---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

This review is against `.apnea/artifacts/phase-05/round-1/phase-package.md`: zero-client idle shutdown and lifecycle diagnostics. The package is aligned with the approved Phase 5 plan. No finding requests Phase 1–3 work.

## Findings

### Critical — Join/leave ownership is still interruptible between count and finalizer state

No source changed in Round 5. In `packages/music-core/session/server.ts`, compatible hello processing still completes the interruptible `onJoin` queue offer and only then assigns `joined = true`. If the connection is interrupted between those operations, the count receives `join` but the finalizer omits `leave`, permanently pinning the daemon above zero. Make that ownership transfer interruption-safe and test an immediate post-negotiation disconnect at the handoff.

### High — Required Phase 5 lifecycle evidence is still missing

No tests changed. The focused command still executes one initial zero-client expiry test only. The Phase 5 package additionally requires real selected-server evidence for:

- cancel/restart behavior through compatible hello, two clients, non-last departure, last departure, rejoin, and final expiry;
- raw pre-hello, malformed, and incompatible sockets not affecting client presence;
- idle-triggered Phase 1 cleanup order, exact artifact cleanup, and signal/idle/defect winner semantics;
- executable no-client status-zero idle exit with bounded cleanup;
- managed reconnect remaining on A before expiry and adopting B after A exits;
- bounded structural lifecycle diagnostics with no playback payload.

These are explicit Phase 5 acceptance checks. They remain acknowledged as residual risks in the coder result.

### High — `MusicSessionConfigLive` still cannot configure idle grace

The environment-backed Config layer continues to omit `idleGraceMs` and does not pass it to `resolve`, although it exposes the other runtime timings. The required validated production override is therefore absent. Focused rejection coverage for negative, fractional, non-finite, and unsafe values also remains missing.

### Medium — Verification remains partial

Round 5 reports only the prior single focused idle test and `git diff --check`. It does not provide the required combined client/server run, uncached full target matrix, raw-timer scan, or exact phase-diff inspection.

## Coder-result discrepancy

The Round 5 result says the supplied review requests Phase 1–3 work. The actual prior artifact, `.apnea/artifacts/phase-05/round-4/code-review.md`, contains only the Phase 5 findings repeated above. Because no source or test rework occurred, none is resolved.
