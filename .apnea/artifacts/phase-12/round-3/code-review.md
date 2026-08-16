---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 12 intent remains aligned with the approved plan, but its internal package-surface contradiction is still unresolved. It requires the installed harness to use `resolveMusicSessionRuntimePaths` through the package name while explicitly forbidding both the root export and any package-export change that would make that symbol importable. Round 3 deliberately retains a copied runtime layout instead. This cannot be approved against the current package; the package must either authorize an importable config surface or explicitly accept the supplied-runtime boundary.

## Findings

### High — The required installed runtime resolver is still replaced by duplicated layout knowledge

The harness manually constructs `naxodev-music-<uid>/s.sock` and `start.lock`. It never invokes the installed `resolveMusicSessionRuntimePaths`, so the smoke can pass while the packed resolver's layout or validation changes incompatibly. The coder result correctly identifies that this is caused by the package contradiction, but acknowledging the contradiction does not satisfy the acceptance check. Resolve the package decision before another implementation round.

### High — The verifier can still remove the temporary root without confirmed process-group termination

`installedSmoke()` unconditionally removes `root` in its `finally`. If `command()` cannot terminate or confirm termination of the harness process group, it throws, but control still reaches that unconditional removal. The verifier can therefore delete the install/runtime tree while an exact child remains alive—the ordering the package explicitly forbids.

In addition, `terminate()` sends a signal to `-child.pid` without treating `ESRCH` as “already exited.” On a nonzero harness exit with no surviving group, the post-exit cleanup path can turn the real captured harness failure into a misleading signal error. Make process-group termination idempotent, preserve the original diagnostics, and gate root removal on confirmed group exit.

### High — A startup timeout can still lose the pending client acquisition

Round 3 retains `clientAcquisition`, but cleanup merely waits on it through another ten-second `bounded()` call. If that second timeout wins, cleanup records the error, kills child processes, and exits without ever observing or disposing a client that resolves later. The underlying reconnect supervisor remains outside harness ownership until process termination.

On timeout, first stop the retained exact daemon/startup boundary, then await the acquisition's terminal outcome and dispose any acquired client before declaring cleanup complete. An additional timeout around the same uncancelled Promise does not close the ownership gap.

## Resolved findings

Round 3 now:

- drains subprocess output concurrently;
- gives the Node harness an owned process group with SIGTERM/SIGKILL escalation;
- uses Node's built-in TypeScript stripping instead of Bun bundling or an extra compiler dependency;
- prints the negotiated protocol revision;
- completes the exact required build/typecheck/test/format/package matrix successfully;
- retains the invalid-option, empty-PATH, Effect-config, protocol-bound, dry-pack, and artifact checks from Round 2.

## Verification

The reported installed smoke, dry-pack check, full 261-test core matrix, artifact scan, and `git diff --check` pass. Approval remains blocked by the unresolved package-surface requirement and the two failure-path ownership gaps above.
