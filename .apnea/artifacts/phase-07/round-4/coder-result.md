---
status: done
---

## Changed

- Moved shared artwork miss ownership to a fiber forked into the coordinator scope, so an individual connection awaiting the lookup cannot own or cancel it for other joined callers.
- Made completion/removal uninterruptible and conditional on the exact admitted Deferred identity. Coordinator-scope interruption now removes the entry and fails joined waiters; failure/success completion has no remove-before-settle gap.
- Changed available-result validation to calculate bounded decoded bytes before cache insertion.

Files touched:

- `packages/music-core/session/coordinator.ts`

## Verification

```text
$ bunx tsc -p packages/music-core/tsconfig.json --noEmit
exit 0

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 88 pass, 0 fail

$ bunx prettier --check packages/music-core/session/client.ts packages/music-core/session/coordinator.ts && git diff --check
exit 0
```

## Residual risks

- The package-required artwork-specific test matrix is still absent, including deterministic shared-owner interruption coverage; only baseline client/coordinator tests were run.
- Config/schema handling of impossible tiny frame limits still needs dedicated correction and tests.
- `.apnea/state.json` was not edited.
