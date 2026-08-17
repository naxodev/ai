---
status: done
---

## Changed

- Scoped the successful signal-wait test’s fiber and joins it through `Fiber.join`, so assertion failures close the scope instead of depending on a particular signal listener being registered.
- Raced closing-refusal callback observation against client closure/error and opens both test latches in `finally`; a connection failure now fails immediately and still releases server finalization.

Files touched:

- `packages/music-core/tests/session-server.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts -t 'executable.*cleanup failure|closing.*refus'
exit 0
2 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts
exit 0
25 pass, 0 fail
112 expect() calls

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

- The expected multiple-cleanup-failure scenario continues to emit its warning during the full server suite.
- No commit, squash, push, or `.apnea/state.json` edit was performed.
