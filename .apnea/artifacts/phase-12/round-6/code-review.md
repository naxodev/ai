---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 12 package is unchanged and remains internally contradictory despite its overall alignment with the approved plan:

- it requires the harness to import and call installed `resolveMusicSessionRuntimePaths` by package name;
- it forbids the root or subpath export needed to make that symbol importable; and
- it requires both confirmed process termination before deleting owned files and unconditional deletion when termination cannot be confirmed.

These are package-policy decisions, not issues a coder can resolve while obeying the current scope.

## Findings

### High — Phase-package amendment is required before approval

Round 6 correctly makes no product change. The existing harness still uses a structurally supplied unique runtime rather than the unexported installed resolver, and it retains a reported temporary root only when deleting beneath an unconfirmed live process would be unsafe. Both choices are consistent with the approved plan's lifecycle intent, but each violates literal requirements in the current phase package.

Amend the Phase 12 package to select one of the following runtime policies:

1. authorize a public root/subpath config export and require the installed resolver; or
2. preserve the current package surface and explicitly accept a unique structurally supplied runtime.

Also authorize reported root retention when exact process-group termination cannot be established, or define another achievable strategy that confirms termination before unconditional cleanup. Do not dispatch another source-code round until those policies are explicit.

## Implementation status

No new implementation finding is introduced in Round 6. Under the current supplied-runtime and fail-safe-retention policies, the prior code findings are resolved: installed code runs under Node by package name, daemon selection comes from the installed manifest, startup/disposal and exact children are bounded and owned, invalid configuration and protocol/replay are checked, provider discovery is isolated, and successful idle exit cleans all owned artifacts.

## Verification

The reported installed smoke, exact dry-pack check, full build/typecheck/261-test/format/package matrix, artifact scan, and `git diff --check` all pass. Approval remains blocked solely because the tasked phase package has not been amended.
