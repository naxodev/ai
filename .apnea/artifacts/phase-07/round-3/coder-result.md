---
status: done
---

## Changed

- Replaced separate artwork settled/in-flight refs with one coordinator-scoped atomic store. Admission now atomically hits, joins, evicts settled LRU-order entries for a new distinct lookup, or applies the finite in-flight budget.
- Added owner interruption cleanup that removes the in-flight entry and fails all joiners; provider failures also remove/fail before returning. Successful completion atomically removes in-flight and inserts only bounded available data.
- Hardened explicit artwork admission to mirror transport lifecycle, pending-capacity, request-ID-exhaustion, and write-callback error handling.
- Revalidated provider-returned available base64 envelope size before cache insertion.

Files touched:

- `packages/music-core/session/client.ts`
- `packages/music-core/session/coordinator.ts`

## Verification

```text
$ bunx tsc -p packages/music-core/tsconfig.json --noEmit
exit 0

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 88 pass, 0 fail

$ git diff --check
exit 0
```

## Residual risks

- The requested artwork-specific system-media/protocol/coordinator/server test matrix and fake-provider artwork controls are still absent, so the new atomic/interruption behavior lacks focused automated coverage.
- The configuration/schema envelope relationship for impossible tiny frames remains derived rather than rejected before acquisition.
- `.apnea/state.json` was not edited.
