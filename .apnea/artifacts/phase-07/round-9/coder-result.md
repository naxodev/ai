---
status: done
---

## Changed

- Added protocol coverage for available artwork result canonical base64 acceptance and rejection of malformed, noncanonical, malformed-padding, and over-schema-limit values.

Files touched:

- `packages/music-core/tests/session-protocol.test.ts`

## Verification

```text
$ bun test packages/music-core/tests/session-protocol.test.ts
exit 0 — 9 pass, 0 fail

$ git diff --check
exit 0
```

## Residual risks

- Payload schema/config/frame relationship and impossible tiny-frame rejection remain unresolved.
- The broader Phase 7 native adapter, coordinator, server, client, reconnect, and non-interference acceptance matrix remains incomplete.
- `.apnea/state.json` was not edited.
