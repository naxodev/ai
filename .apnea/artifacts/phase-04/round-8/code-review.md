---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains within its six allowed files. Round 8 adds meaningful real-socket stale classification, idempotent removal, and replacement-preservation evidence.

## Findings

### High — The stale-socket fixture is not failure-safe

`leaveStaleSocket()` acquires a real `net.Server`, then performs `chmod`, `rename`, and `server.close()` sequentially without `try/finally`. If chmod, rename, or close setup fails, the listener remains open and the calling test's recursive directory cleanup cannot reliably release it. This violates the package's explicit failure-safe ownership requirement and can leave the suite hanging.

Declare acquisition state before `try`, close/destroy the listener in `finally`, and only return after closure has been observed while preserving the renamed stale socket fixture.

### High — Incompatible and conservative peer discovery remain unverified

Add a discovery-level disjoint-range case proving `incompatible` preserves client/daemon ranges, exposes no cleanup, retains directory/socket identity, and allows a subsequent supported client. Add malformed and reset peer cases proving they return `occupied` with no cleanup authority and leak no raw socket. The existing protocol/server tests do not exercise the managed discovery classifier.

### High — Managed artifact and marker fail-closed coverage remains incomplete

The suite still lacks foreign-owned and non-directory runtime roots; symlinked, foreign-owned, and wrong-mode sockets; and dead, unknown-error, malformed, wrong-mode, symlinked, foreign-owned, and non-regular markers. Stale replacement is covered only by a regular file, not the required symlink case, and endpoint disappearance after refusal is no longer covered.

Use the injected seam only for ownership/process facts unavailable to an unprivileged test, and prove every unsafe/replacement artifact remains untouched.

### High — Managed server and executable boundaries remain incomplete

There is still no post-bind hardening-failure cleanup test or second-managed-server test proving the first endpoint remains unchanged and connectable. The executable suite still lacks no-flag managed-default preparation, explicit override behavior, and tagged operation/path/message diagnostics with nonzero status for an unsafe managed runtime.

## Verification

The coder reports 53 focused tests and 183 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. The new stale cases pass, but the remaining Phase 4 acceptance boundaries above are not established.
