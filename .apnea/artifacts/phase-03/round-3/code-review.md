---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan. The round-3 change is confined to the allowed client test file and correctly removes the real-launcher leak identified previously.

## Findings

### High — A live marker now masks socket type and ownership violations, not only the pre-hardening mode window

The Phase 3 production change in `packages/music-core/session/config.ts:547-562` treats every invalid socket artifact as pending whenever any valid live marker exists. That branch covers `!isSocket()`, foreign ownership, and wrong mode alike. A legitimate listener startup can temporarily explain only a same-owner Unix socket that has not yet been hardened to `0600`; it cannot explain a regular file, symlink, directory, or foreign-owned socket.

Because `ManagedRuntimeProbe.inspect` retries through this branch (`config.ts:690-705`), adding a valid live marker changes those unsafe artifacts from immediate `MusicSessionRuntimeError` failures into scheduled `starting`/`missing` outcomes and eventual timeout. This weakens the secure type/owner checks that the package requires Phase 3 to preserve. Restrict the marker-authorized exception to the exact same-owner Unix-socket pre-hardening state, and add combined live-marker coverage showing files, symlinks, unexpected types, and foreign ownership still fail closed and remain untouched.

## Verification

The prior detached-daemon issue is fixed: the primary/release-failure test now injects a no-op launcher, asserts one launch attempt, and the default managed socket/process are absent. The coder also supplied passing focused, combined, full-target, timer-scan, and diff evidence. Those suites do not exercise unsafe socket artifacts while a live marker is present, so they do not catch the remaining regression above.
