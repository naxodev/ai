---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains within its six allowed files. Round 9 makes the stale fixture failure-safe, adds real discovery-level incompatibility evidence, and covers both regular-file and symlink stale replacements.

## Findings

### High — Conservative peer classification remains unverified

Add real malformed and reset peer cases through `discoverMusicSession()`. Each must complete without hanging, return `occupied` with no cleanup capability, preserve the peer/socket artifact, and prove the unsuccessful client probe destroys its raw socket/listeners. Endpoint disappearance after a real refused probe also remains uncovered.

These cases distinguish “listener exists but hello failed” from a genuine no-listener stale socket and are central to preventing unsafe cleanup.

### High — Managed artifact and marker fail-closed coverage remains incomplete

The suite still lacks foreign-owned and non-directory runtime roots; symlinked, foreign-owned, and wrong-mode socket artifacts; and dead, unknown-error, malformed, wrong-mode, symlinked, foreign-owned, and non-regular markers. A dead marker must yield guarded cleanup only with no healthy endpoint, while every other unsafe/unknown marker must remain untouched and grant no cleanup.

Use real files and symlinks where possible and the observation seam only for foreign ownership/process outcomes.

### High — Managed server acquisition boundaries remain incomplete

There is still no deterministic post-bind hardening-failure case proving the partially bound identity is removed while listener/coordinator resources finalize. Add a second-managed-server case proving it neither changes permissions nor closes/unlinks the first endpoint and that a client can still complete hello afterward.

### High — Executable default/explicit behavior remains unverified

Add focused executable evidence that no `--socket` selects and prepares the managed default, an absolute flag remains explicit/unmanaged, and an unsafe managed runtime reports tagged operation/path/message diagnostics with nonzero status. Preserve the existing injectable runner and prove neither path starts coordination/spawning.

## Verification

The coder reports 54 focused tests and 184 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. The new stale/incompatible cases are supported, but the remaining Phase 4 acceptance boundaries above are not yet established.
