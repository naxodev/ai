---
status: done
---

## Changed

- Extracted the daemon executable into an injectable in-file runner. It retains the production graph and single `Effect.runPromise` boundary, installs signal handling before reporting readiness, and reports retained tagged cleanup failures with a nonzero status.
- Replaced synthetic closing-callback invocation with an Effect-owned finalizer gate and refusal observation hook around the real Node acceptance callback.
- Reworked the focused executable test to use a real child process, real `SIGTERM`, injected post-close failure, and cleanup in `finally`; it asserts exit status, tagged operation/message diagnostics, remaining unlink cleanup, and path removal.
- Reworked the closing-refusal test to connect to the real Unix listener after `closing` is set and before listener close, then releases its gate in `finally`.
- Moved vulnerable early socket/server acquisitions into `try` blocks so their resources are released if later setup or assertions fail.

Files touched:

- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-server.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts -t 'executable.*cleanup failure|closing.*refus'
exit 0
2 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts
exit 0
25 pass, 0 fail
111 expect() calls

$ bun test packages/music-core/tests/session-coordinator.test.ts packages/music-core/tests/system-media.test.ts
exit 0
65 pass, 0 fail
241 expect() calls

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
152 pass, 0 fail
Verified npm package contents (21 files)
NX   Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Effect\.runSync|setTimeout\(|setInterval\(" packages/music-core/session/coordinator.ts packages/music-core/session/provider.ts packages/music-core/session/server.ts
exit 0
(no matches)

$ jj diff --summary
exit 0
M packages/music-core/session/music-sessiond.ts
M packages/music-core/session/server.ts
M packages/music-core/tests/session-server.test.ts
(existing unrelated .apnea artifacts/state/task changes remain preserved)
```

## Residual risks

- The child-process test intentionally imports the in-file runner directly; it is not added to the public package barrel.
- Existing expected-cleanup-failure coverage emits its existing warning during the complete server suite.
- No commit, squash, push, or `.apnea/state.json` edit was performed.
