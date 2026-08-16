---
status: done
---

## Changed

- Added reconnecting-client artwork coverage proving one delegation to generation A, `CONNECTION_LOST` settlement, no replay to B, and late-A fencing.
- Added native-adapter tests distinguishing timeout from ordinary command failure and proving normal sample/stream commands remain `--no-artwork`.

Files touched:

- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/system-media.test.ts`

## Verification

```text
$ bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-client.test.ts -t 'artwork'
exit 0 — 8 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — all targets passed; 253 tests passed

$ git diff --check
exit 0

$ ! rg -n 'itunes|itunes\.apple|pngjs|kitty|half.block|artworkUrl|fetch\(' packages/music-core
exit 0 — no matches
```

## Residual risks

- Real selected-server blocked-read isolation/final-response containment and the remaining coordinator cancellation/capacity races are still pending review coverage.
- `.apnea/state.json` was not edited.
