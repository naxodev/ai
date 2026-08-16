---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains confined to its six allowed files. The latest round adds foreign-owner/non-directory coverage, simulated refusal disappearance, and executable selection/diagnostic tests.

## Findings

### High — The “wrong-mode socket” case is not a socket

In `managed discovery rejects unsafe socket artifacts...`, both `file` and `wrong-mode` create a regular file; the latter merely chmods that file to `0644`. Discovery can therefore reject it solely for wrong type, so the test does not prove that a real same-user Unix socket with non-`0600` permissions is rejected and retained.

Use a real live or stale Unix socket, change only its mode, then assert typed rejection, unchanged device/inode/mode, no connection, and no cleanup/unlink.

### High — Executable tests bypass managed preparation and real path-error propagation

`executable selects managed default or explicit socket through one graph` replaces the complete graph with `Layer.succeed`; it proves only which options are passed to the seam, not that no-flag execution actually prepares/binds the managed default. Likewise, the tagged-failure test throws `MusicSessionRuntimeError` directly from the graph factory, so it does not exercise a real unsafe managed-directory failure through config/server wrapping and executable diagnostics.

Add focused composition evidence using the selected options with the real config/server ownership boundary (a fake provider is sufficient): prove managed directory/socket preparation for no flag, explicit unmanaged behavior for the flag, and an actual unsafe managed runtime reaching operation/path/message plus nonzero status. Keep process startup/spawning out of the test.

## Verification

The coder reports 65 focused tests and 195 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. Most Phase 4 security/discovery behavior is now covered, but the two acceptance assertions above do not yet exercise the claimed boundaries.
