---
status: done
---

## Changed

Made the real executable-composition fixture failure-safe:

- Tracks the asynchronous socket observation promise explicitly.
- Captures and rethrows observation failures only after the daemon scope returns.
- Emits the test SIGTERM in the observation task’s `finally`, ensuring the signal gate releases and scoped server/provider cleanup completes even when `lstat` fails.

Files touched:

- `packages/music-core/tests/session-server.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
65 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
195 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- No startup coordination, spawning, retry, reconnect, or idle-shutdown behavior was added.
