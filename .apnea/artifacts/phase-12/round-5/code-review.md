---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

Phase 12 remains blocked at the package level, before further implementation review. The approved plan requires an isolated packed-core Node lifecycle, but does not require a new public runtime-path export. The phase package adds two mutually unsatisfiable constraints:

1. invoke installed `resolveMusicSessionRuntimePaths` through the package name; and
2. do not change the root export or add a subpath export that makes it importable.

It also requires unconditional temporary-root deletion on every failure while requiring deletion to occur only after exact process termination is confirmed. If termination cannot be confirmed, both conditions cannot be met safely.

Revise the phase package to choose explicit policies. The current implementation cannot receive an `APPROVED` verdict against contradictory acceptance criteria.

## Findings

### High — Installed resolver acceptance is still not satisfied

The harness continues to construct the temporary runtime object itself. It does not call the installed `resolveMusicSessionRuntimePaths`, so it remains nonconforming with implementation step 2.2. Either authorize a root/subpath export or explicitly accept a structurally supplied unique runtime as the process-location boundary. The latter remains consistent with the approved plan and avoids expanding the package surface.

### Medium — Unconfirmed process-group cleanup deliberately violates unconditional cleanup wording

When exact harness-group termination cannot be proven, the verifier retains and reports its unique temporary root. That is the safer behavior—deleting files beneath a potentially live process would violate ownership ordering—but it conflicts with the package's requirement to remove the archive, install project, runtime files, and root on every failure. Amend the package to authorize retained, reported recovery state when exact termination cannot be established, or define another achievable policy.

## Resolved findings

Round 5 correctly separates late acquisition failure from late-client disposal failure. A successfully acquired client remains retained when disposal fails, cleanup fails, and ordinary outer process-group termination completes before root removal. It also captures subprocess output incrementally and preserves bounded partial stdout/stderr when group cleanup cannot be confirmed.

No additional blocking implementation finding was found under the coder's stated supplied-runtime and fail-safe-retention policies.

## Verification

The installed Node smoke, exact dry-pack check, full build/typecheck/261-test/format/package matrix, artifact scan, and `git diff --check` all pass. Product changes remain confined to the four permitted Phase 12 files. A revised phase-package decision is required before this phase can be approved.
