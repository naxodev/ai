---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains within its six allowed files. Round 12 adds real malformed, wrong-mode, symlinked, and non-regular marker evidence with fail-closed retention.

## Findings

### High — Unsafe managed directory/socket coverage remains incomplete

Add deterministic foreign-owned and non-directory runtime-root cases, plus symlinked, foreign-owned, and wrong-mode socket artifacts. Each must reject with `MusicSessionRuntimeError`, preserve type/identity/content/mode, and prove no connection or cleanup attempt occurred. Endpoint disappearance after a genuine no-listener attempt also remains uncovered.

### High — Marker boundary coverage is not yet complete

The marker matrix still lacks oversized input, schema-valid JSON with mismatched marker UID, and simulated foreign ownership. Add those cases and assert exact artifact identity/mode/content is retained. Also prove an incompatible healthy endpoint takes precedence over a marker and leaves its identity unchanged, complementing the existing compatible precedence case.

### High — Managed server acquisition boundaries remain incomplete

There is still no deterministic post-bind hardening-failure case proving the partially bound socket identity is removed while listener/coordinator resources finalize. Add a second-managed-server case proving it neither chmods, closes, nor unlinks the first endpoint and that a supported client can still complete hello afterward.

### High — Executable default/explicit behavior remains unverified

Add focused executable evidence that no flag selects and prepares the managed default, an absolute `--socket` remains explicit/unmanaged, and an unsafe managed runtime retains tagged operation/path/message diagnostics and sets nonzero status. Preserve the one graph/runtime boundary and prove no startup coordination or spawning entered either path.

## Verification

The coder reports 58 focused tests and 188 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. Invalid marker handling is now substantially covered, but the remaining Phase 4 filesystem, server-acquisition, and executable boundaries above are not established.
