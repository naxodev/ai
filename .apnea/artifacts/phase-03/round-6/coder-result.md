---
status: done
---

## Changed

- Replaced the handshake/active listener transfer with one `Client`-owned socket callback set for the complete connection lifetime.
- Added explicit handshaking/active/terminal/disposed routing. The client transitions to active before readiness resolves and retains pre-hello non-hello frames for ordered active delivery.
- Terminal and disposal transitions now reject a pending handshake, detach the same exact listener set once, and preserve the existing truthful pending-command semantics.

Files touched:

- `packages/music-core/session/client.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-server.test.ts
exit 0
41 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
163 pass, 0 fail
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
