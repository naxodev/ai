---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 2 package matches the approved plan. The product diff is confined to `packages/opencode-music-player/scripts/package-smoke.ts` and retains the existing presentation scenarios without changing the package pin or product behavior.

## Findings

### High — Cleanup can remove the install without confirming the exact tmux server is gone

`packages/opencode-music-player/scripts/package-smoke.ts:16,55-64,265,357-360` records `tmuxStarted` only after `tmux new-session` returns success and calls `terminateTmux()` in the outer `finally` only when that flag is true. A launch that starts the unique server/socket but then returns an error therefore skips termination and recursively removes the temporary root beneath a potentially live host. This misses the phase package's explicit requirement to run exact-resource cleanup after launch failure and to terminate/confirm tmux before deleting its files.

Additionally, `terminateTmux()` treats any nonzero `list-sessions` result as proof that the server is absent. An inspection/connection error is therefore silently accepted as successful termination rather than retaining the root with cleanup diagnostics.

Always attempt cleanup for the exact unique tmux socket once that socket identity is known, including after a failed `new-session`, and distinguish confirmed server absence from an unconfirmed inspection failure. If exact termination cannot be confirmed, fail and retain/report the root instead of removing it.

## Verification

The coder supplied successful output for all four phase verification commands. The happy-path smoke proves the exact `0.0.0-next-17386` installed binary, isolated packed plugin/core resolution, retained UI scenarios, and successful normal cleanup. That passing path does not cover the required launch-failure cleanup ordering above.
