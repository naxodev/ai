---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 2 package remains aligned with the approved plan, and the cumulative diff remains confined to allowed paths. The round addresses hello-first ordering, negotiated incomplete EOF, exactly-one incompatibility response, major mismatch, and impossible client capability results.

## Findings

### High — Oversized-frame behavior is still unproved at the real server boundary

The package explicitly requires a compact real-socket oversized-frame case and acceptance that oversized input remains connection-local under the negotiated shared boundary. The only oversized test still exercises `NdjsonFramer` directly; no socket sends an over-limit frame to `MusicSessionServer`, observes that offending connection close, and then proves the healthy negotiated peer remains usable.

Add that focused case to the existing combined compatibility test (using the configured frame limit and the failure-safe handle pattern). This is the final listed negotiated-boundary scenario from the package and does not expand lifecycle scope.

## Verification

The coder reports 40 focused tests and all 162 music-core/package checks passing. The new cases support the prior findings, but the package's real-server oversized-frame acceptance evidence remains absent.
