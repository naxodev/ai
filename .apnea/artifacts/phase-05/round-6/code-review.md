---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved zero-client idle-shutdown plan, and Round 6 stays within the allowed config/server/executable/client-test paths.

## Findings

### High — Required idle/reconnect interaction is still not tested

The package requires two idle-specific managed-client cases: reconnect before A's grace expires must rejoin the same A generation without launching B, and reconnect after A genuinely idles out must retain state and adopt a new B generation through the existing startup workflow. Round 6 adds neither case. The inherited Phase 4 replacement test closes A explicitly and therefore is not evidence for idle grace cancellation or idle-triggered replacement. This acceptance cannot be delegated to generic reconnect regression coverage.

### High — Signal/idle/defect convergence and exact selected-graph cleanup remain incomplete

The expanded TestClock test proves normal client counting and observes the final coordinator/provider/listener suffix, but the package also requires a narrow signal-versus-idle race and simultaneous defect-versus-idle behavior, including proof that a genuine defect cannot become a successful idle exit and that every owner finalizes once. No such idle race was added.

The test also does not assert exact-once connection input/forwarder finalization, listener close/unlink identity, bind-reservation/temporary-name absence, or the complete coordinator → connections → provider → listener/unlink sequence required for idle cleanup. `order.slice(-3)` omits the connection portion and cannot establish the full selected-graph contract.

### Medium — The repaired join handoff lacks its requested race evidence

Wrapping queue enrollment and `joined = true` in one uninterruptible region fixes the Round 1 source race. However, the new normal client lifecycle test does not force interruption immediately after join admission, so it does not prove that the admitted join receives exactly one finalizer leave under the handoff race. Add a deterministic gate/hook at that boundary and assert the count returns to zero once, without a phantom or duplicate leave.

### Medium — Executable diagnostics and cleanup evidence are partial

The child test proves listening, status-zero idle exit, idle/stopped diagnostics, and socket/bind-lock absence. It does not check provider ownership, signal-listener cleanup, temporary reservation names, stream/collector completion on both success and failure, or that diagnostics exclude playback/artwork payloads as required by the package. Lifecycle diagnostics for client-count and grace start/cancel/expiry are tested only as hooks, not checked as bounded diagnostic records.

## Resolved findings

- `idleGraceMs` is now present in the environment-backed Config layer with valid override and zero/negative/fractional/non-finite/unsafe rejection coverage.
- Compatible-hello join ownership is now transferred interruption-safely.
- Real TestClock coverage now proves initial grace, compatible cancellation, two-client/non-last behavior, last-client restart, rejoin cancellation, and one expiry.
- Real raw pre-hello, malformed, and incompatible sockets are shown not to pin idle expiry.

## Verification

The coder supplied passing evidence for 3 focused idle tests, 100 combined client/server tests, the 230-test build/typecheck/test/format/package matrix, raw-timer scan, exact phase-diff inspection, and `git diff --check`. The remaining findings are missing explicit Phase 5 acceptance, not reported command failures.
