---
status: done
---

## Changed

- Added a real Unix-socket oversized-frame test against a server configured with a 4096-byte frame limit.
- The test waits for the oversized peer to close, then issues another healthy-client command to prove connection-local isolation.

Files touched:

- `packages/music-core/tests/session-server.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
40 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
162 pass, 0 fail
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
