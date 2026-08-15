---
status: done
---

## Changed

Addressed the latest Phase 3 review findings in `packages/music-core/tests/session-client.test.ts`:

- Exposed a terminal-safe full captured-frame snapshot and asserted exactly the original hello plus two admitted transports after connection loss, so replayed frames are detected.
- Made scripted-daemon `write(...chunks)` issue and await distinct ordered socket writes instead of joining chunks.
- Updated stream coverage to prove a frame split across separate writes and multiple complete frames delivered in one write, while retaining listener-isolation and command-use evidence.
- Awaited malformed-frame injections and safely handled intentionally late disposal writes.

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

- The complete Phase 3 diff remains uncommitted and includes prior approved client/protocol/server-test work for review.
- Scripted-daemon ownership remains failure-safe through test `finally` cleanup; no timing or polling helpers were introduced.
