---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The assigned package and this review concern only Phase 5 zero-client idle shutdown and lifecycle diagnostics. The package remains aligned with the approved plan; none of the findings below requests Phase 1–3 baseline work.

## Findings

### Critical — The negotiated-client count can still retain a phantom join

Round 4 makes no source change. The compatible-hello path still yields the interruptible `onJoin` queue offer before setting `joined = true` in `packages/music-core/session/server.ts`. Interruption after the offer succeeds but before the assignment makes the finalizer skip `onLeave`, leaving the idle supervisor permanently above zero. Enrollment and leave ownership must transfer interruption-safely, with a deterministic immediate-close race test.

### High — The Phase 5 acceptance matrix remains absent

Round 4 adds no tests; the focused command still runs only one initial no-client expiry case. The assigned package also requires Phase 5-specific evidence for:

- real compatible-client cancellation, two-client counting, non-last/last departure, rejoin cancellation, and fresh expiry;
- raw pre-hello, malformed, and incompatible peers not pinning idle shutdown;
- idle-triggered selected-graph ordering, exact owned-artifact cleanup, and signal/idle/defect convergence;
- executable no-client idle exit with status zero and bounded process/signal/resource cleanup;
- reconnect staying on A before expiry and adopting B after genuine A idle exit;
- bounded structural client-count/grace/shutdown diagnostics without playback payloads.

These scenarios are stated verbatim by the Phase 5 package. They are not requests to reimplement Phase 1–3.

### High — Production Config still omits `idleGraceMs`

The environment-backed `MusicSessionConfigLive` layer still has no idle-grace `Config` entry and does not pass one to `resolve`, while exposing the other runtime timings. The required validated production override and focused negative/fractional/non-finite/unsafe rejection evidence remain missing.

### Medium — Round 4 verification is incomplete

Only the prior one-test focused output and `git diff --check` are cited. Round 4 supplies no combined client/server run, uncached full target matrix, raw-timer scan, or exact phase-diff evidence. Regardless, verification cannot replace the missing Phase 5 acceptance cases.

## Coder-result discrepancy

The Round 4 coder result describes a different review requesting Phase 1–3 work. The actual preceding artifact, `.apnea/artifacts/phase-05/round-3/code-review.md`, explicitly identifies the Phase 5 join/leave race, idle acceptance matrix, and idle-grace Config omission above. No requested finding was addressed.
