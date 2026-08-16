---
status: done
---

## Changed

- Added generation fencing to reconnecting artwork delegation: late completion from a replaced or disposed generation now rejects with the current lifecycle error rather than resolving stale artwork.
- Updated the reconnect test fixture and coverage to retain an A-generation artwork Promise through B adoption, then prove its late completion is ignored and never replayed to B.

Files touched:

- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`

## Verification

```text
$ bun test packages/music-core/tests/session-client.test.ts -t 'reconnecting artwork'
exit 0 — 1 pass, 0 fail

$ bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 196 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — all targets passed; 253 tests passed

$ git diff --check
exit 0

$ ! rg -n 'itunes|itunes\.apple|pngjs|kitty|half.block|artworkUrl|fetch\(' packages/music-core
exit 0 — no matches
```

## Residual risks

- Coordinator cancellation/capacity and selected-server blocked-read/final-wire containment coverage remain for review.
- `.apnea/state.json` was not edited.
