---
status: done
---

## Changed

- Reconciled native artwork bytes, canonical base64 schema, and frame envelope limits; impossible tiny frames now fail configuration before graph acquisition.
- Enabled `native-artwork` in default client negotiation and retained explicit old-peer capability behavior.
- Added fake-provider artwork controls plus focused adapter and selected-server coverage for identity checks, bounded results, capability gating, and cache reuse.

Files touched: `packages/music-core/session/config.ts`, `protocol.ts`, `client.ts`, `provider.ts`, and allowed music-core tests.

## Verification

```text
$ bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 191 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — all targets passed; 248 tests passed

$ jj diff --summary
exit 0

$ ! rg -n 'itunes|itunes\.apple|pngjs|kitty|half.block|artworkUrl|fetch\(' packages/music-core
authoritative exit 0 — no matches

$ git diff --check
exit 0
```

## Residual risks

- Existing dirty Phase 7 source remains intentionally preserved; this round did not alter `.apnea/state.json`.
- The full acceptance matrix still warrants independent review, especially blocked lookup cancellation and reconnect-generation race coverage.
