---
status: done
---

## Changed

- Added schema-owned canonical base64 validation for available artwork results, including bounded encoded length, alphabet/padding validation, and canonical round-trip enforcement.
- Coordinator now schema-validates provider artwork results before using them, computes decoded byte size from validated padding without decoding, maps malformed results to non-cached `unavailable`, and maps over-limit validated data to `too-large`.

Files touched:

- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/coordinator.ts`

## Verification

```text
$ bunx tsc -p packages/music-core/tsconfig.json --noEmit
exit 0

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — build, typecheck, format, package checks passed; 242 pass, 0 fail

$ git diff --check
exit 0
```

## Residual risks

- Impossible tiny frame-limit configuration is still derived rather than rejected.
- The required Phase 7 artwork-specific acceptance matrix remains absent.
- `.apnea/state.json` was not edited.
