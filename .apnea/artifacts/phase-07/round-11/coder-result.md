---
status: done
---

## Changed

- Added Effect-native artwork controls to the coordinator provider fixture.
- Added deterministic coordinator coverage for pre-read staleness, equal-key in-flight sharing, post-read authority invalidation, command-lane progress during a blocked read, failure retry, bounded cache eviction, and re-read.
- Extended native adapter cases for noncanonical base64, missing native identity, and malformed JSON output.

Files touched:

- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- `packages/music-core/tests/system-media.test.ts`

## Verification

```text
$ bun test packages/music-core/tests/session-coordinator.test.ts packages/music-core/tests/system-media.test.ts
exit 0 — 70 pass, 0 fail

$ bunx nx run music-core:typecheck
exit 0 — typecheck passed

$ git diff --check
exit 0
```

## Residual risks

- The remaining review-requested explicit/reconnecting client lifecycle and broader server connection-isolation cases are not covered by this focused rework.
- `.apnea/state.json` was not edited.
