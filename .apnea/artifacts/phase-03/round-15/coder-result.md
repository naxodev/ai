---
status: done
---

## Changed

Completed the requested Phase 3 rework in `packages/music-core/tests/session-client.test.ts`:

- Added deterministic active-stream malformed nested status/state, NDJSON, and partial-EOF coverage, including pending-command, terminal, cache, and listener assertions.
- Expanded transport-loss coverage to two in-flight commands, terminal error/close ordering, closure observation, and no-replay evidence.
- Expanded disposal coverage to observe closure and prove late response/status/state/error/end/close activity cannot alter caches or listeners.

No production source files were changed during this rework. No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-server.test.ts
exit 0
50 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
172 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "setTimeout\\(|Bun\\.sleep|Date\\.now\\(|Effect\\.yieldNow" packages/music-core/tests/session-client.test.ts
exit 0

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/protocol.ts
M packages/music-core/tests/session-client.test.ts
M packages/music-core/tests/session-server.test.ts
(existing phase artifacts/tasks and .apnea/state.json remain pre-existing dirty worktree changes)

$ git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both commands exited successfully.

## Residual risks

- The scripted daemon intentionally uses real local sockets and deterministic event signals; no timing/polling helpers were added.
- Existing accumulated Phase 3 source/test changes remain uncommitted for review.
