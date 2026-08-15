---
status: done
---

## Changed

- Strengthened the in-file scripted daemon with deterministic accepted, received-frame, and closed signals; raw split/multiple writes; and end/destroy controls.
- Synchronized scripted request tests on actual captured client frames before replying.
- Added clean-EOF in-flight settlement/no-replay coverage and exercised a higher accepted state followed by a stale middle revision.

Files touched:

- `packages/music-core/tests/session-client.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts
exit 0
10 pass, 0 fail

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-server.test.ts
exit 0
45 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
167 pass, 0 fail
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
