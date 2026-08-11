---
status: done
---

## Changed

- Hardened the raw `subscribeAttempt` seam with exact-once source disposal, including synchronous terminal-before-return and late callback suppression.
- Replaced the provider mixed sliding callback bridge with separate capacity-one conflated snapshot and terminal paths, supervised Effect retries, typed source acquisition, and scoped source cleanup.
- Added deterministic `Latch`/`TestClock` coverage for retries, startup failure recovery, interruption, synchronous disposal, and backpressured snapshot/terminal delivery.

Files touched:
- `packages/music-core/system-media.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/system-media.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/system-media.test.ts
exit 0 — 37 pass, 0 fail

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core
exit 0 — typecheck, 118 tests, format:check, and package:check passed

$ ! rg -n "Effect\.runSync|Effect\.runPromise|setTimeout\(|setInterval\(" packages/music-core/session/provider.ts
exit 0

$ jj diff --summary
exit 0 — preserved accumulated migration/docs changes; Phase 1 product/test changes are confined to the three package-approved paths.
```

## Residual risks

- Later coordinator and socket/server concerns remain intentionally out of Phase 1 scope.
