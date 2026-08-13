---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan. This re-dispatched round makes no product or test changes; per-connection late-forwarder and blocked-sampling lifecycle findings are resolved, but remaining package gates prevent approval.

## Findings

### High — Executable cleanup failure remains unverified at the process boundary

Signal-handler removal and direct Layer composition are covered, but no runtime executable-path test proves signal-driven dependency-order cleanup or that close/unlink failure sets nonzero process status while retaining tagged operation/message diagnostics. Promise-facade and direct-Layer failure tests do not establish the required Node process boundary.

### Medium — Actual production closing-state refusal remains unobserved

Callback-entry shutdown proves the enrolled-and-finalized branch because the callback continues synchronously before the Effect runtime sets `closing`. Synthetic `canEnroll` refusal proves generic destruction, but no callback is deterministically delivered after production marks the server closing and before listener close completes. One side of the acceptance-vs-shutdown ownership decision remains unproved.

### Medium — Failure-safe cleanup remains incomplete across older focused tests

Recent comprehensive, blocked-work, and lifecycle tests use `try/finally`, but several earlier socket/error tests still release resources only on success paths. An intermediate assertion can leak clients, sockets, listeners, or paths despite the package's requirement that every focused test clean up on failure.

## Verification

The coder reports 23 server tests, 65 coordinator/provider tests, all package targets, static scans, and `jj diff --summary` passing. Independent worktree inspection confirms product changes remain confined to allowed Phase 3 files; `.apnea/state.json` remains a pre-existing unrelated modification. No new evidence addresses the findings above.
