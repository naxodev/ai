---
status: done
---

## Changed

- Moved the encoded base64 length check inside the canonical schema filter before regex/Buffer work. Because Effect Schema accumulates checks, this prevents a separate max-length failure from still allowing canonical round-trip allocation of an attacker-controlled over-limit string.

Files touched:

- `packages/music-core/session/protocol.ts`

## Verification

```text
$ bunx tsc -p packages/music-core/tsconfig.json --noEmit
exit 0

$ bun test packages/music-core/tests/session-protocol.test.ts
exit 0 — 8 pass, 0 fail
```

## Residual risks

- Schema/config/frame relationship and impossible tiny frame validation remain unresolved.
- The complete required artwork-specific acceptance matrix remains absent.
- `.apnea/state.json` was not edited.
