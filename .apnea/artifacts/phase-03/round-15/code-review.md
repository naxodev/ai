---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the cumulative diff remains confined to the four allowed files. Round 15 substantially completes the invalid-stream, multi-command loss, closure, and post-disposal listener/cache evidence.

## Findings

### High — The no-replay assertion cannot detect replayed frames

In `connection loss races leave every admitted command indeterminate without replay`, the final assertion calls `daemon.received(3)`. That helper always returns `received.slice(0, 3)`, so it equals the earlier three-frame snapshot even if a fourth or later replay frame was received. The test therefore proves one connection but not the package's required daemon-observed no-replay behavior.

Expose a terminal-safe total frame count or full snapshot and, after `await daemon.closed()`, assert that exactly the hello and two original transport frames were received.

### Medium — The scripted daemon's “split” API joins chunks into one write

`write(...chunks)` currently executes `socket.write(chunks.join(""))`. Consequently, the test named `split and multiple status frames...` does not send split writes; it sends one combined write containing two complete frames. This leaves the package's real-socket split-frame seam/evidence unfulfilled.

Have the helper issue the supplied chunks as separate ordered writes with awaitable completion, then use that API in the focused split-frame test. Keep the multiple-frame-in-one-write assertion as separate evidence.

## Verification

The coder reports 50 focused tests, 172 music-core tests, all requested build/typecheck/format/package targets, the timing-pattern scan, and `git diff --check` passing. This supports the new cases, but the two assertions above do not yet prove the claimed no-replay and split-write boundaries.
