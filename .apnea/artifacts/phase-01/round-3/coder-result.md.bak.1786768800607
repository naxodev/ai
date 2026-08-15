---
status: done
---

## Changed

- Made `SessionProvider.events` Layer-owned and shared through a bounded Effect multicast, so concurrent consumers subscribe to one supervised provider attempt rather than materializing independent raw sources.
- Added deterministic evidence that two consumers receive the same snapshot while exactly one raw source exists and Layer shutdown disposes it once.

Files touched:
- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/system-media.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/system-media.test.ts
exit 0 — 42 pass, 0 fail

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core
exit 0 — typecheck, 123 tests, format:check, and package:check passed

$ ! rg -n "Effect\.runSync|Effect\.runPromise|setTimeout\(|setInterval\(" packages/music-core/session/provider.ts
exit 0

$ jj diff --summary
exit 0 — preserved accumulated migration/docs changes; Phase 1 changes remain confined to approved provider/system-media/focused-test paths.
```

## Residual risks

- Coordinator and server work remains intentionally outside this Phase 1 package.
