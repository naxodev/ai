---
status: done
---

## Changed

- Added an in-file real Unix-socket scripted-daemon seam with NDJSON client-frame capture and arbitrary daemon frame delivery.
- Added deterministic client coverage for unsolicited/duplicate response isolation, request-local typed failures followed by success, repeated disposal semantics, ordered correct-instance state authority, and listener-exception isolation.
- Preserved failure-safe server/socket/client/path cleanup in each new test.

Files touched:

- `packages/music-core/tests/session-client.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts
exit 0
9 pass, 0 fail

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-server.test.ts
exit 0
44 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
166 pass, 0 fail
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
