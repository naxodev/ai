---
status: done
---

## Changed

- Updated coordinator optimistic play/pause/seek commits to atomically project over the state current after transport, using the Effect clock rather than `Date.now()`.
- Made poll triggers capacity-one sliding rather than unbounded.
- Added an Effect-native coordinator provider fixture with scoped event source, latches, counters, and native Effect operations.
- Reworked coordinator focused tests around the native fixture, deterministic event readiness, command ordering, state replay, optimistic seek preservation, and 3/5/8-second polling.

Files touched:
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/session-coordinator.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-coordinator.test.ts
exit 0 — 5 pass, 0 fail

$ bun test packages/music-core/tests/system-media.test.ts
exit 0 — 42 pass, 0 fail

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core
exit 0 — typecheck, 113 tests, format:check, and package:check passed

$ ! rg -n "Effect\.runSync|setTimeout\(|setInterval\(|Date\.now\(" packages/music-core/session/coordinator.ts
exit 0

$ ! rg -n "createFakeProvider|layerFromLegacy|Effect\.repeat\(Effect\.yieldNow|new Promise" packages/music-core/tests/session-coordinator.test.ts
exit 0

$ jj diff --summary
exit 0 — Phase 2 product/test edits are confined to coordinator, provider fixture, and coordinator tests; pre-existing `.apnea/state.json` modification was preserved untouched.
```

## Residual risks

- The package's broader deterministic race/closure/config-provider matrix still needs expansion in follow-up review; no socket/server work was changed.
