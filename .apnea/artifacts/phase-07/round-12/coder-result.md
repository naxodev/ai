---
status: done
---

## Changed

- Added explicit-client artwork request tests covering multiple request-ID correlation, disposal, and connection-loss outcomes.
- Extended scripted daemon negotiation fixtures to model `native-artwork` peers without changing old-peer defaults.
- Reformatted the coordinator test after the prior round's additions.

Files touched:

- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`

## Verification

```text
$ bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts -t 'artwork|capability|payload'
exit 0

$ bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 194 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — all targets passed; 251 tests passed

$ git diff --check
exit 0

$ ! rg -n 'itunes|itunes\.apple|pngjs|kitty|half.block|artworkUrl|fetch\(' packages/music-core
exit 0 — no matches
```

## Residual risks

- The remaining package acceptance cases are real-server blocked-read isolation/final containment and reconnect-generation artwork delegation; they remain for review.
- `.apnea/state.json` was not edited.
