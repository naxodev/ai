---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains confined to its six allowed files. The latest round closes the substantive wrong-mode socket, ownership/disappearance, executable composition, default/explicit selection, and real managed-path diagnostic evidence gaps.

## Findings

### High — The executable composition test can hang instead of failing safely

In `executable composes one real graph for managed default and explicit sockets`, the listening diagnostic starts an untracked `void (async () => { observed = await lstat(...); signals.emit("SIGTERM") })()` task. If `lstat` rejects—for example, precisely when socket preparation regresses—the rejection is unhandled and `SIGTERM` is never emitted. `runMusicSessionDaemon()` then waits forever, so the test cannot enter its `finally` cleanup.

Track the observation Promise/error explicitly and emit the signal in `finally`; after the daemon returns, await/rethrow the observation before assertions. This preserves deterministic failure while guaranteeing the signal gate is released and resources are finalized on the negative path, as required by the package's failure-safe test ownership rule.

## Verification

The coder reports 65 focused tests and 195 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. The behavior matrix is now comprehensive, but the new executable test's failure path must be made ownership-safe before approval.
