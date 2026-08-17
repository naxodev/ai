---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

## High — Current-code real-host initialization and final cleanup are not verified

The coder result explicitly states that current-code regular-pane host observations remain outstanding. No exact OpenCode `opencode2 v0.0.0-next-17386` or Pi `0.84.0` isolated checkout-loaded run is retained after the latest production changes, so the phase's primary host acceptance check is unmet.

The required closed-state gate is also currently false: review inspection found PID 45621 running `packages/music-core/dist/music-sessiond.js` and the production `0600` socket still present. The process is attributed to an active OpenCode parent and must not be killed as unrelated cleanup, but Phase 1 cannot be approved until an owned clean window is available and both exact host runs plus idle cleanup are retained.

## High — Early-exit diagnostics are still tested only below the host acquisition boundary

The diagnostic test calls `launch.earlyFailure()` directly. No test drives an early child exit through `connectOrStartMusicSessionEffect` and proves the host receives `operation: "exit"`, exit code/signal, and bounded diagnostic rather than `timeout` or `occupied`. That coordinator-level assertion was requested in the prior review and is an explicit phase-package acceptance requirement.

Coverage also only rejects arbitrary non-prefixed output. Add the required sensitive-payload assertions demonstrating that playback/artwork/environment sentinels cannot appear in a host-visible diagnostic, while preserving a bounded causal message.

## Medium — Verification and retained red/green evidence remain incomplete

The reported full `music-core:test` result is carried over from Round 3 rather than rerun on the Round 4 working copy. The parent and non-Apnea scope are correct on review inspection, and no package debris was found, but the dispatched coder result must retain the complete current gate itself.

Earlier red-loop commands still contain `...`, and no retained failing run of the causal regression before the production fix has been supplied. Complete the exact agent-runnable red/green transcript and all phase-package commands after the owned production daemon is naturally closed.
