---
status: done
---

## Changed

- Fixed the selected provider-event pull so the eager first pull is consumed once, then subsequent pulls delegate to the live provider stream. Previously `Stream.fromPull` retained the first completed pull and replayed it indefinitely, preventing later authoritative snapshots from reaching the coordinator.
- Restored and expanded the isolated oversized-state regression: after the target connection locally overflows and finalizes, a strictly newer bounded snapshot is observed at the coordinator; a normal `state-replay` client receives replay and completes a protocol `play()` command.

Files touched in this rework:

- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-server.test.ts`

## Verification

```text
$ bun test packages/music-core/tests/session-server.test.ts -t 'oversized provider state'
exit 0 — 1 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t '24|slow reader|backpressure|overflow'
exit 0 — 5 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 135 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — build, typecheck, format, package checks passed; 242 pass, 0 fail

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts
exit 0

$ git diff --check
exit 0
```

## Residual risks

- None identified for the reviewed post-overflow recovery path. The pre-existing `.apnea/state.json` modification and unrelated orchestrator artifacts were not edited.
