---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains within its six allowed files. Round 13 extends marker rejection to oversized content and marker/runtime UID mismatch.

## Findings

### High — Unsafe managed directory/socket ownership and type coverage remains incomplete

Add deterministic foreign-owned and non-directory runtime-root cases, plus symlinked, foreign-owned, and wrong-mode socket artifacts. Each must reject with `MusicSessionRuntimeError`, remain present with its original type/identity/mode, and prove no connection or cleanup attempt occurred. Simulated foreign marker ownership also remains uncovered.

Endpoint disappearance after a genuine no-listener attempt is still missing; it must classify through marker/absence rules without stale authority or an identity-change error.

### High — Managed server acquisition boundaries remain incomplete

There is still no deterministic post-bind hardening-failure case proving the partially bound socket identity is removed while listener/coordinator resources finalize. The current server has no focused seam exercising failure after identity capture but before hardening completes.

Add a second-managed-server case proving it neither changes permissions nor closes/unlinks the first endpoint, and that a supported client can still complete hello afterward.

### High — Executable default/explicit behavior remains unverified

Add focused executable evidence that:

- no flag selects and prepares the managed default;
- an absolute `--socket` remains explicit/unmanaged;
- unsafe managed-runtime failure retains tagged operation/path/message diagnostics and sets nonzero status;
- neither path adds startup coordination or spawning.

Preserve the existing injectable runner and one graph/runtime ownership boundary.

## Verification

The coder reports 58 focused tests and 188 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. Marker schema/size handling is supported, but the remaining ownership, server-acquisition, and executable boundaries above are not established.
