---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan, and the cumulative diff remains confined to its six allowed files. The latest change completes the post-bind hardening evidence by proving listener closure, exact partial-socket removal, neighboring-file retention, managed-directory retention, and exactly-once provider disposal.

## Findings

### High — Managed ownership/type and disappearance acceptance remains incomplete

Add deterministic cases for:

- foreign-owned and non-directory runtime roots;
- symlinked, foreign-owned, and wrong-mode socket artifacts;
- simulated foreign marker ownership;
- a socket disappearing after a genuine no-listener attempt.

Each unsafe artifact must fail with `MusicSessionRuntimeError`, retain its original type/identity/mode/content, and produce no connection or cleanup capability. The disappearance case must classify through marker/absence rules without stale authority or an identity-change error. Use the existing observation seam only for ownership facts unavailable to an unprivileged test.

### High — Executable default and explicit modes remain unverified

The package still requires focused executable evidence that:

- no `--socket` selects and prepares the compact managed default as managed;
- an absolute flag remains explicit/unmanaged and does not impose managed-parent policy;
- unsafe managed-runtime failure retains tagged operation/path/message diagnostics and sets nonzero status;
- both modes retain one scoped graph and add no startup coordination or spawning.

Exercise the real argument/config selection boundary while retaining the injectable process/signal/diagnostic seams.

## Verification

The coder reports 60 focused tests and 190 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. Partial-hardening cleanup is now fully supported; the remaining ownership/disappearance and executable acceptance boundaries above still block approval.
