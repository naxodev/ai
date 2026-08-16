---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The assigned package and the prior Round 2 review are both explicitly about Phase 5 zero-client idle shutdown. The package remains aligned with the approved plan and does not request Phase 1–3 implementation.

## Findings

### Critical — The negotiated join can still lose its matching leave

Round 3 makes no source change. A compatible hello still performs the interruptible `yield* onJoin` before assigning `joined = true` in `packages/music-core/session/server.ts`. If interruption occurs after the queue accepted the join but before the assignment, the connection finalizer skips `onLeave`, leaving a phantom client count that prevents idle shutdown. Transfer enrollment and leave ownership interruption-safely and prove the immediate-close race deterministically.

### High — Explicit Phase 5 acceptance remains unimplemented and unproven

Round 3 adds no tests. The focused suite still contains only one initial no-client expiry case. The package additionally requires real selected-server evidence for:

- grace cancellation, two-client counting, non-last departure, last-client restart, rejoin cancellation, and fresh exact-once expiry;
- raw pre-hello, malformed, and incompatible peers not pinning the daemon;
- selected Phase 1 cleanup order, exact artifact identity, signal/idle/defect convergence, and no masked defect;
- executable startup-loss idle exit with status zero and bounded resource cleanup;
- managed reconnect rejoining A before expiry and adopting B after A exits;
- bounded structural lifecycle diagnostics with no playback payload.

These are Phase 5 requirements quoted by the prior review, not out-of-scope Phase 1–3 requests. The coder result's own residual-risk section acknowledges that Phase 5 acceptance scenarios remain outstanding.

### High — The environment-backed `idleGraceMs` setting remains absent

`MusicSessionConfigLive` still omits an idle-grace `Config` entry and does not pass one into `resolve`, despite exposing the other runtime timings. Production therefore cannot receive the required validated environment-backed override. Focused rejection evidence for negative, fractional, non-finite, and unsafe idle-grace values also remains absent.

### Medium — Round 3 verification remains incomplete

Only the single focused idle test and `git diff --check` were reported. The required combined client/server suite, uncached full target matrix, raw-timer scan, and exact phase-diff inspection were not supplied. In any event, the unchanged single idle test does not cover the missing acceptance above.
