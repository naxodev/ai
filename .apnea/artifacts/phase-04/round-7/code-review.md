---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains within its six allowed files. Round 7 adds the required narrow observation seam and useful wrong-mode directory, symlinked directory, regular-file socket, and `EPERM` marker evidence.

## Findings

### High — Core stale/incompatible discovery acceptance remains unverified

The suite still has no real no-listener stale socket fixture, so the phase's primary cleanup capability has not been exercised end to end. Add focused real-socket evidence for refusal plus identity recheck, idempotent cleanup, disappearance, and replacement with a regular file or symlink that must be retained.

There is also no discovery-level disjoint protocol-range test proving `incompatible` preserves both ranges, exposes no cleanup capability, leaves socket/directory identity unchanged, and permits a later supported client. Malformed/reset peers likewise remain untested as conservative `occupied` results with no cleanup.

### High — Managed artifact and marker fail-closed coverage remains incomplete

Round 7 covers `0755` and symlinked directories, a regular-file socket, and marker `EPERM`. The package still requires deterministic evidence for foreign-owned and non-directory runtime roots; symlinked, foreign-owned, and wrong-mode sockets; and dead, unknown-error, malformed, wrong-mode, symlinked, foreign-owned, and non-regular markers. Assert each unsafe artifact remains unchanged and no cleanup capability is returned.

Use the new dependency seam only for facts that cannot be created unprivileged; keep real files/symlinks/sockets for the rest.

### High — Managed server and executable boundaries remain incomplete

The server suite still lacks post-bind hardening-failure cleanup and a second managed server proving it cannot chmod, close, or unlink the first while the first remains connectable. The executable suite still lacks no-flag managed-default preparation, explicit override behavior, and tagged operation/path/message diagnostics with nonzero status for an unsafe default runtime.

These are explicit package sections 5–8 acceptance checks and cannot be deferred to startup/reconnect phases.

## Verification

The coder reports 51 focused tests and 181 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. The new seam and cases are supported, but the remaining core Phase 4 classifications and cleanup boundaries above are not yet covered.
