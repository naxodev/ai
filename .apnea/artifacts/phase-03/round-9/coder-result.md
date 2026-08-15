---
status: done
---

## Changed

- Made scripted-daemon receive waiters removable and terminal-aware: close/error rejects outstanding and future frame waits instead of allowing tests to hang.
- Added connection counting and failure-safe listener-start cleanup to the scripted daemon.
- Extended state/listener coverage with actual post-unsubscribe suppression and late-subscriber replay/live delivery.
- Added malformed transport-success terminal/indeterminate coverage and asserted the loss path uses one connection.

Files touched:

- `packages/music-core/tests/session-client.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts
exit 0
11 pass, 0 fail

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-server.test.ts
exit 0
46 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
168 pass, 0 fail
Verified npm package contents (21 files)
NX   Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "setTimeout\\(|Bun\\.sleep|Date\\.now\\(|Effect\\.yieldNow" packages/music-core/tests/session-client.test.ts
exit 0

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/protocol.ts
M packages/music-core/tests/session-client.test.ts
M packages/music-core/tests/session-server.test.ts
(existing phase artifact/state/task changes remain preserved)
```

## Residual risks

- Existing cleanup-failure coverage logs its intentional injected unlink warning.
- No commit, squash, push, or `.apnea/state.json` edit was performed.
