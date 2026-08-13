---
status: done
---

## Changed

- Factored the atomic sampling claim and poll-deadline attach transitions into typed coordinator helpers.
- Added direct deterministic sampling-claim coverage proving an active ticket is marked stale with a single coalesced catch-up.
- Added a reserve-to-attach poll interleaving test: a newer installed deadline rejects and interrupts a stale older candidate.

Files touched:
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/tests/session-coordinator.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-coordinator.test.ts
exit 0 — 23 pass, 0 fail

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

- Command admission remains covered through the configured bounded-lane behavior; tests use concurrent Effect submissions rather than a production test hook.
