---
status: done
---

## Changed

- Wrapped artwork admission and coordinator-scope workflow startup in an uninterruptible mask. The caller is restored only while awaiting the shared Deferred, so interruption cannot leave an admitted Deferred without its coordinator-owned worker.
- Added all-cause workflow cleanup to complete/remove the exact deferred for defects as well as typed failure and interruption.

Files touched:

- `packages/music-core/session/coordinator.ts`

## Verification

```text
$ bunx tsc -p packages/music-core/tsconfig.json --noEmit
exit 0

$ bun test packages/music-core/tests/session-coordinator.test.ts
exit 0 — 23 pass, 0 fail

$ git diff --check
exit 0
```

## Residual risks

- Artwork-specific acceptance tests, canonical runtime-result validation, and impossible-frame config validation remain unresolved.
- `.apnea/state.json` was not edited.
