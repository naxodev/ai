---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan and the cumulative diff remains within its six allowed files. Round 6 restores the prescribed module boundary: `config.ts` owns opaque filesystem identity/cleanup state, while `client.ts` owns the real connection and hello classification. The circular import is removed.

## Findings

### High — The required filesystem/process seam and Phase 4 acceptance matrix remain missing

Round 6 changes no tests. Filesystem observation and `process.kill` remain hard-coded, so the package's required deterministic foreign-owner and `EPERM`/unknown-process cases still cannot be exercised through a narrow test dependency seam.

The current managed coverage remains limited to layout/basic preparation, healthy discovery, healthy-over-malformed-marker precedence, one live marker, ordinary managed shutdown, and bound-path replacement. It still lacks focused evidence for:

- exact wrong-mode, symlinked, foreign-owned, and non-directory runtime roots without repair/removal;
- regular, symlinked, foreign-owned, and wrong-mode socket retention;
- real disjoint-range incompatible discovery, structured ranges, unchanged identity, and later healthy reuse;
- a real no-listener stale socket, disappearance, idempotent cleanup, and file/symlink replacement refusal;
- dead, `EPERM`/unknown, malformed, wrong-mode, symlinked, foreign-owned, and non-regular markers;
- malformed/reset peers returning `occupied` with no cleanup capability;
- post-bind hardening failure cleanup and a second managed server leaving the first connectable;
- executable no-flag managed-default behavior, explicit override behavior, and tagged runtime path diagnostics.

These are explicit package sections 7–8 and acceptance requirements. Add the narrow filesystem/process observation seam and failure-safe real-resource tests before approval.

## Verification

The coder reports 48 focused tests and 178 music-core tests passing, with build, typecheck, format, package, production spawn scan, and diff checks green. The transcript supports the module-boundary rework but does not establish the unresolved Phase 4 security/classification matrix.
