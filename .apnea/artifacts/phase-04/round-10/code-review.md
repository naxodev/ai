---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains within its six allowed files. Round 10 adds real malformed/reset peer evidence for conservative `occupied` classification, no cleanup capability, probe closure, and retained socket identity.

## Findings

### High — Managed directory/socket fail-closed coverage remains incomplete

The suite still lacks foreign-owned and non-directory runtime roots, plus symlinked, foreign-owned, and wrong-mode socket artifacts. Use real wrong-type/symlink resources and the injected stat seam only for foreign ownership. Assert rejection is typed, no artifact is repaired or removed, and no connection/cleanup is attempted.

Endpoint disappearance after a genuine no-listener attempt also remains uncovered; the package requires it to classify as absence rather than stale or an identity-change failure.

### High — Marker classification and cleanup remain largely unverified

Only live and `EPERM` markers are covered. Add focused cases for:

- a valid dead marker with no endpoint yielding guarded, idempotent marker cleanup;
- unknown process errors remaining `starting` with no cleanup;
- malformed/oversized JSON, UID mismatch, wrong mode, symlink, foreign owner, and non-regular marker artifacts failing closed and remaining untouched;
- healthy/incompatible endpoint precedence leaving marker identity unchanged.

The existing healthy-over-malformed-marker case proves one precedence path but not dead-marker cleanup or the unsafe marker matrix required by section 7.

### High — Managed server acquisition boundaries remain incomplete

There is still no deterministic post-bind hardening-failure case proving the partially bound socket identity is removed while listener/coordinator resources finalize. Add a second-managed-server case proving it does not chmod, close, or unlink the first endpoint and that a client can still complete hello afterward.

### High — Executable default/explicit behavior remains unverified

Add focused executable evidence that no flag selects/prepares the managed default, an absolute `--socket` remains explicit/unmanaged, and unsafe managed runtime failure retains tagged operation/path/message diagnostics and sets nonzero status. Preserve the one graph/runtime boundary and prove no process launch entered either path.

## Verification

The coder reports 55 focused tests and 185 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. Conservative peer behavior is now supported, but the remaining Phase 4 filesystem, marker, server-acquisition, and executable boundaries above are not established.
