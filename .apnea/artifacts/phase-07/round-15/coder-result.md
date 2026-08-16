---
status: done
---

## Changed

- Added deterministic artwork fixture observations for start order and provider interruption.
- Added coordinator coverage for interrupted owner/joiner behavior, distinct in-flight capacity recovery, and scope-close interruption/finalization with all waiters settled.
- Added real selected-server coverage for cross-client sharing, state/other-client command progress while blocked, stale completion, pending-client disposal isolation, provider failure retry, and bounded/malformed/unavailable wire results.
- Added reconnecting-client coverage that fences an artwork completion after managed disposal.

Files touched:

- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- `packages/music-core/tests/session-server.test.ts`

## Verification

```text
$ bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts -t 'artwork|capability|payload'
exit 0 — 14 pass, 0 fail

$ bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 202 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — all targets passed; 259 tests passed

$ jj diff --summary
exit 0 — inspected accumulated dirty baseline and package paths

$ git diff --check
exit 0

$ ! rg -n 'itunes|itunes\.apple|pngjs|kitty|half.block|artworkUrl|fetch\(' packages/music-core
exit 0 — no matches
```

One initial full focused-suite attempt hit the existing concurrent managed-startup race (`occupied`); its isolated retry and the final focused suite both passed. No startup/singleton code was changed because it is outside this phase package.

## Residual risks

- The existing 20-caller managed-startup test remains timing-sensitive outside Phase 7 scope.
- `.apnea/state.json` was not edited.
