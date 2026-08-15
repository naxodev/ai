---
status: done
---

Fixed the review finding in the selected server graph. The coordinator scope now starts and retains the selected provider event stream's first pull before activation, then supplies that exact pull to the fixed coordinator graph. This preserves a single event source, prevents first-event loss, and retains event-source finalization in the coordinator scope. Restored the three legacy event-disposal assertions to exact-once behavior.

Files changed for this rework:
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-server.test.ts`

Verification:

```text
$ bun test packages/music-core/tests/session-server.test.ts -t 'selected.*blocked|blocked.*selected'
exit: 0
(pass) selected graph shutdown interrupts blocked coordinator work before draining connections
1 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts
exit: 0
35 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit: 0
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core
203 pass, 0 fail

$ ! rg -n 'Effect\.runSync|setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit: 0

$ jj diff --summary
exit: 0
Inspected: only the package's server, daemon, and server-test product paths are present alongside pre-existing dirty worktree files.

$ jj diff --git packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/tests/session-server.test.ts
exit: 0
Inspected: provider-only selection, separate ownership scopes, eager selected event pull, and coordinator -> connection -> provider -> listener teardown order are present.

$ git diff --check
exit: 0
```

Residual risks: none identified. `.apnea/state.json` and unrelated dirty worktree changes were not modified.
