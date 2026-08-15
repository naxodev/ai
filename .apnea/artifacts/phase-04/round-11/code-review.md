---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains within its six allowed files. Round 11 adds valid dead-marker cleanup and unknown-process-error `starting` evidence, completing the principal process-existence classifications.

## Findings

### High — Unsafe managed directory/socket coverage remains incomplete

The suite still lacks foreign-owned and non-directory runtime roots, plus symlinked, foreign-owned, and wrong-mode socket artifacts. Add deterministic cases asserting typed failure, unchanged artifact identity/content/mode, and no connection or cleanup attempt. Endpoint disappearance after a genuine no-listener attempt also remains uncovered.

### High — Invalid marker artifacts remain unverified

Add focused malformed/oversized JSON, marker UID mismatch, wrong mode, symlink, foreign-owner, and non-regular marker cases. Each must fail closed with `MusicSessionRuntimeError`, preserve the artifact, and expose no cleanup capability. Also prove incompatible endpoint precedence leaves a marker untouched, complementing the existing healthy precedence case.

### High — Managed server acquisition boundaries remain incomplete

There is still no deterministic post-bind hardening-failure case proving the partially bound socket identity is removed while listener/coordinator resources finalize. Add a second-managed-server case proving it neither chmods, closes, nor unlinks the first endpoint and that a supported client can still complete hello afterward.

### High — Executable default/explicit behavior remains unverified

Add focused executable evidence that no flag selects/prepares the managed default, an absolute `--socket` remains explicit/unmanaged, and unsafe managed runtime failure retains tagged operation/path/message diagnostics and sets nonzero status. Preserve the one graph/runtime boundary and prove no startup coordination or spawning entered either path.

## Verification

The coder reports 57 focused tests and 187 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. Marker process classification is now supported, but the remaining Phase 4 filesystem, server-acquisition, and executable boundaries above are not established.
