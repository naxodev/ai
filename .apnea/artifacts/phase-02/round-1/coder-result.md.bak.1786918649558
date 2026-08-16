---
status: done
---

## Changed

Added a test-only separate-process daemon contention proof in `packages/music-core/tests/session-server.test.ts`.

- Starts two `runMusicSessionDaemon` children behind a parent-controlled stdin barrier for the same explicit Unix socket.
- Uses the real selected provider graph and records bounded stderr lifecycle observations.
- Proves a single healthy listener/coordinator/provider winner, real hello/replay from two clients, socket identity/mode preservation after loser exit, and clean winner shutdown.
- Proves the tagged nonzero loser has no coordinator, subscription, provider-finalization, sample, or command ownership.
- Ensures clients, child processes, stderr collectors, and temporary socket/reservation artifacts are released unconditionally.

No production source files were changed.

## Files touched

- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-02/round-1/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts -t 'process.*daemon.*contender|daemon.*winner.*loser'
exit 0
1 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts
exit 0
36 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
204 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ jj diff --summary
exit 0
M packages/music-core/tests/session-server.test.ts
(existing unrelated phase metadata/state/task changes remain outside this implementation)

$ jj diff --git packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/tests/session-server.test.ts
exit 0
Only packages/music-core/tests/session-server.test.ts changed among inspected Phase 2 product paths.

$ git diff --check
exit 0
```

## Residual risks

- The existing intentional multi-cleanup test continues to emit its expected tagged unlink warning during the server suite.
- No commit, push, or `.apnea/state.json` edit was performed.
