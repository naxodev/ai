---
status: done
---

## Changed

- Reworked bounded-command tests to publish every competing submission result through test-side Effect queues.
- While the active transport remains blocked, each test now awaits `SERVER_BUSY`; that outcome deterministically proves the peer crossed admission and occupies the configured queue slot before release or scope close.
- After the boundary, tests prove the enrolled command runs FIFO after release or settles `DISPOSED` after close.

Files touched:
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

- No known Phase 2 acceptance gaps remain in the focused coordinator coverage.
