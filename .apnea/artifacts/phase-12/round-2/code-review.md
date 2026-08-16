---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 12 intent remains aligned with the approved plan, and Round 2 correctly removes the forbidden `packages/music-core/index.ts` change. However, the package's internal surface conflict remains unresolved: it explicitly requires the harness to create paths with the installed `resolveMusicSessionRuntimePaths`, while also forbidding the root export needed to import that function by package name. Round 2 now manually duplicates the runtime layout instead. The package must be clarified or the resolver requirement satisfied through an approved package surface; trading one requirement for the other is not sufficient for approval.

## Findings

### High — Failure cleanup can still hang or finish without proving child exit

The verifier's `command()` timeout calls `child.kill()` and then awaits `child.exited` without a second timeout or escalation. If the Node harness does not honor SIGTERM, the verifier remains hung indefinitely and never reaches temporary-root cleanup.

Inside the harness, `cleanup()` escalates to SIGKILL but swallows the second `waitForExit()` timeout. It can therefore remove the runtime root and return without proving the exact daemon exited. The outer verifier also owns only the harness process, not its process group, so it cannot clean the daemon if the harness is unresponsive.

There is an additional late-acquisition hole: `bounded(createReconnectingMusicSessionClient(...))` can reject on timeout before assigning `client`; the underlying acquisition remains live and cannot be disposed by `cleanup()`. It can resolve or continue supervising after cleanup has begun.

Retain bounded ownership through final exit: use an exact harness process/group boundary, escalate on timeout, await the final exit after escalation, and do not lose the underlying client acquisition when the timeout wins. Capture stdout/stderr concurrently so timeout failures remain actionable rather than potentially blocking on full pipes.

### High — The installed runtime-path resolver requirement is no longer exercised

The harness now constructs `directory`, `socketPath`, and `markerPath` by copying the resolver's current naming scheme. This does not execute the installed `resolveMusicSessionRuntimePaths` requested by the package and can remain green if the packed resolver changes incompatibly. It also weakens the claim that the lifecycle uses the installed public config path.

Resolve the package contradiction identified above. If manually supplied paths are the intended boundary, revise the phase package explicitly; otherwise provide an approved importable installed config surface without widening `index.ts` contrary to scope.

### Medium — The temporary install includes an undeclared test-runtime dependency

The generated install manifest adds `typescript@5.9.3` as a dev dependency solely for the custom loader. The package asks for a minimal install whose only application dependency is the tarball and for runtime dependencies to come from the packed manifest. Although Node now resolves the packed package by name, this additional compiler changes how its sources execute and is neither part of the packed package contract nor repository-pinned TypeScript 7. Prefer the supported Node type-stripping/loader boundary or explicitly authorize and pin any external smoke runtime helper in the phase package.

### Medium — Required smoke output omits the negotiated revision

The package requires the smoke report to include the negotiated daemon instance **and revision**. The harness prints only `negotiated daemon: <instance-id>` even though it validates `selectedRevision`. Include the revision in the successful report.

### Medium — The exact regression matrix has no successful run

The required `run-many` command reportedly failed, followed only by an isolated `music-core:test` rerun. Even if the first failure is a known flaky test, the phase acceptance evidence requires a successful execution of the exact build/typecheck/test/format/package matrix after the final changes. Re-run the full command to a zero exit.

## Resolved findings

Round 2 now:

- loads the installed package by name under Node through a temporary ESM loader rather than a Bun-generated client bundle;
- removes the out-of-scope root exports;
- invokes the manifest-selected daemon with invalid idle grace and checks status/config diagnostics and artifact absence;
- uses an owned empty PATH for deterministic provider-unavailable behavior;
- delegates idle-grace policy validation to Effect configuration;
- validates the negotiated revision against installed `PROTOCOL` bounds;
- preserves dry-pack behavior and the four permitted product paths.

## Verification

The installed smoke, dry-pack check, isolated 261-test core rerun, artifact scan, and `git diff --check` pass. Approval remains blocked by the unresolved package-surface requirement, incomplete failure ownership, and missing exact matrix evidence above.
