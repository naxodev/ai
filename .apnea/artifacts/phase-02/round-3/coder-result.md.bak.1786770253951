---
status: done
---

## Changed

- Removed coordinator dependency on the test fixture and restored a production-only sampling API.
- Split sampling claim from provider execution so invalidation claims/coalesces synchronously before provider work is forked.
- Reworked poll installation to reserve its revision before creating/attaching a sleeper; stale candidates self-cancel and cannot replace a newer deadline.
- Replaced yield-based command saturation/close sequencing with concurrent, result-observing submissions.
- Added focused current-authority poll-deadline coverage.

Files touched:
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/session-coordinator.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-coordinator.test.ts
exit 0 — 20 pass, 0 fail

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

- Poll replacement is covered through newer-authority behavior; no production test hook was added solely to force an internal pre-install interleaving.
