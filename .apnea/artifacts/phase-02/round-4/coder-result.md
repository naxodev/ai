---
status: done
---

## Changed

- Moved fixture event observation into the stream transformation so tests acknowledge delivery before the coordinator consumer, rather than using `Stream.tap`.
- Factored the poll-deadline reservation transition into a typed atomic helper and added direct stale-versus-newer authority coverage.
- Strengthened saturation and closure assertions to validate stable `SERVER_BUSY` and `DISPOSED` error codes.

Files touched:
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/session-coordinator.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-coordinator.test.ts
exit 0 — 21 pass, 0 fail

$ bun test packages/music-core/tests/system-media.test.ts
exit 0 — 42 pass, 0 fail

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core
exit 0 — typecheck, test, format:check, and package:check passed

$ ! rg -n "Effect\.runSync|setTimeout\(|setInterval\(|Date\.now\(" packages/music-core/session/coordinator.ts
exit 0

$ ! rg -n "createFakeProvider|layerFromLegacy|Effect\.repeat\(Effect\.yieldNow|new Promise" packages/music-core/tests/session-coordinator.test.ts
exit 0

$ jj diff --summary
exit 0 — Phase 2 product/test changes are confined to approved paths; pre-existing `.apnea/state.json` remains untouched.
```

## Residual risks

- Direct reservation testing exercises the stale installation transition independently; end-to-end polling tests cover resulting deadline behavior.
