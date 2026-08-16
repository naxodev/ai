---
status: done
---

## Changed

Addressed the Phase 2 review findings in `packages/music-core/tests/session-server.test.ts`.

- Added a bounded Effect timeout around each expected contender exit and stderr collection. A hung loser or a winner that fails to stop now throws into the test body, allowing `finally` to kill and await both retained children before removing the temporary directory.
- After the loser exits, the original winner client now completes a real `play` command before the second client connects, proving that its existing connection remains live rather than merely retaining cached replay state.

No production files were changed.

## Files touched

- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-02/round-2/coder-result.md`

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
