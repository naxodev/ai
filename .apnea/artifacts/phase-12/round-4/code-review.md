---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 12 package still cannot be satisfied as written. It requires the installed harness to call `resolveMusicSessionRuntimePaths` through the package name while forbidding the root/subpath export needed to import it. Round 4 intentionally keeps a copied supplied-runtime layout, so it remains nonconforming. Because the approved plan only requires a unique installed-package runtime—not this contradictory export constraint—the phase package should be amended explicitly before another code round.

## Findings

### High — The installed resolver acceptance remains unimplemented

The harness still manually constructs `naxodev-music-<uid>/s.sock` and `start.lock`; it never executes the installed `resolveMusicSessionRuntimePaths`. This can pass even if the packed resolver changes incompatibly. Either authorize and test an importable installed config surface, or revise the package to accept the explicit structurally supplied runtime. The current implementation cannot be approved against the current wording.

### High — A late client disposal timeout is mistaken for a failed acquisition

In harness `cleanup()`, one `try/catch` covers both:

1. `client = await pendingAcquisition`, and
2. `await bounded(client.dispose(), "late client disposal", 10_000)`.

The catch unconditionally treats either failure as “a failed acquisition,” clears `clientAcquisition`, and records no cleanup failure. If acquisition succeeds but late disposal times out/rejects, `client` remains assigned and live, `runtimeRoot` is removed, and cleanup reports success. This recreates the exact ownership/order problem the round intended to close.

Handle acquisition failure separately from disposal failure. A successfully acquired client must remain owned until disposal reaches a terminal result; a disposal timeout must fail cleanup and must not permit runtime-root removal before the outer exact process boundary has been terminated and confirmed.

### Medium — The explicit retained-root branch violates failure-cleanup acceptance

`installedSmoke()` now intentionally skips `rm(root)` after `ProcessGroupCleanupError`. Retaining files beneath a possibly live child is safer than deleting them, but the package requires the archive, install project, runtime files, and temporary root to be removed on every failure path. This is another package-policy conflict, not successful cleanup. Amend the package to define retention as the required fail-safe outcome, or supply a bounded ownership strategy that both confirms process exit and removes the root.

### Medium — Unconfirmed termination errors drop captured subprocess diagnostics

When process-group termination cannot be confirmed, `command()` throws `ProcessGroupCleanupError` before awaiting/including the already-draining stdout and stderr. The package requires actionable captured output for harness failures. Preserve the original harness output and failure as part of the cleanup error while still reporting the retained recovery path.

## Resolved findings

Round 4 now makes ESRCH termination idempotent, confirms ordinary process-group disappearance, prints the negotiated revision, uses Node's built-in type stripping, and successfully runs the installed smoke, exact dry-pack check, complete 261-test matrix, artifact scan, and diff check.

## Verification

All reported success-path commands pass and no repository smoke artifact remains. Approval is blocked by the unchanged phase-package contradiction and the late-client cleanup bug above.
