---
status: done
---

## Changed

- Made the real-socket frame reader terminal-safe: it drains NDJSON EOF, rejects pending/future reads on end/close/error, and removes every listener on termination/disposal.
- Added same-major disjoint-range negotiation coverage, plus malformed-range and missing-replay current hello failures.
- Added negotiated-session coverage for second hello, duplicate IDs, invalid action, and invalid seek with stable response codes and no coordinator admission.
- Preserved `INVALID_SEEK` classification for malformed seek positions while retaining the schema-owned final transport request validation.
- Added public server-frame decoding tests for malformed nested state/track/device/status data and contradictory failure responses.

Files touched:

- `packages/music-core/session/protocol.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-server.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
39 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
161 pass, 0 fail
Verified npm package contents (21 files)
NX   Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/protocol.ts
M packages/music-core/session/server.ts
M packages/music-core/tests/session-client.test.ts
M packages/music-core/tests/session-protocol.test.ts
M packages/music-core/tests/session-server.test.ts
(existing phase artifact/state/task changes remain preserved)
```

## Residual risks

- The complete server suite intentionally logs its injected unlink failure during cleanup-failure coverage.
- No commit, squash, push, or `.apnea/state.json` edit was performed.
