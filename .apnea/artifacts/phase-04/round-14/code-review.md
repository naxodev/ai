---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains within its six allowed files. Round 14 adds a real second-managed-server regression proving listen refusal, unchanged socket identity/mode, and continued handshake availability.

## Findings

### High — Unsafe managed ownership/type coverage remains incomplete

Add deterministic foreign-owned and non-directory runtime-root cases, plus symlinked, foreign-owned, and wrong-mode socket artifacts and simulated foreign marker ownership. Each must fail with `MusicSessionRuntimeError`, preserve original type/identity/mode/content, and prove no connection or cleanup attempt occurred.

Endpoint disappearance after a genuine no-listener attempt also remains uncovered; it must follow marker/absence classification without stale authority or an identity-change error.

### High — Post-bind hardening failure remains unverified

The server still lacks a deterministic case that fails after partial bound-path identity capture but before hardening completes. Prove the listener closes, only that partially bound socket is removed, coordinator/listener resources finalize, and the tagged hardening failure is retained. Add the narrow lifecycle/dependency seam needed to trigger this ordering without timing.

### High — Executable default/explicit behavior remains unverified

Add focused executable evidence that no flag selects and prepares the managed default, an absolute `--socket` remains explicit/unmanaged, and an unsafe managed runtime retains tagged operation/path/message diagnostics and sets nonzero status. Preserve one config/provider/coordinator/server graph and prove no startup coordination or spawning entered either path.

## Verification

The coder reports 59 focused tests and 189 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. Managed singleton non-interference is now supported, but the remaining ownership, partial-hardening, and executable boundaries above are not established.
