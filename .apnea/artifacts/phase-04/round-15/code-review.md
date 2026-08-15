---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains within its six allowed files. Round 15 adds a deterministic post-bind hardening failure and proves typed rejection, listener closure, partial socket removal, and managed-directory retention.

## Findings

### High — Unsafe managed ownership/type coverage remains incomplete

Add deterministic foreign-owned and non-directory runtime-root cases, plus symlinked, foreign-owned, and wrong-mode socket artifacts and simulated foreign marker ownership. Each must fail with `MusicSessionRuntimeError`, retain original type/identity/mode/content, and prove no connection or cleanup attempt occurred.

Endpoint disappearance after a genuine no-listener attempt also remains uncovered; it must follow marker/absence classification without stale authority or an identity-change error.

### High — Executable default/explicit behavior remains unverified

There is still no focused evidence that:

- no `--socket` selects and prepares the managed default as managed rather than explicit;
- an absolute flag remains unmanaged and does not impose managed-parent policy;
- unsafe managed-runtime failure retains tagged operation/path/message diagnostics and sets nonzero status;
- neither path introduces startup coordination or spawning.

Exercise the executable's real selection/config boundary while preserving its injectable process dependencies and one scoped graph.

### Medium — The hardening-failure test does not prove all acquired resources finalize

The new test observes Node listener closure and socket removal, but it does not assert provider/coordinator finalization or that an unrelated neighboring artifact survives partial cleanup. Extend the fixture with ownership/finalization observations so the package's “all other resources finalize” requirement is explicit, not inferred from Promise rejection.

## Verification

The coder reports 60 focused tests and 190 music-core tests passing, with build, typecheck, format, package, production spawn scan, summary, and diff checks green. Partial-bind cleanup is now exercised, but the remaining ownership and executable boundaries above still block Phase 4 approval.
