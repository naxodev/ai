---
status: done
---

## Changed

Implemented the Phase 4 managed reconnect client in the existing session client module.

- Added exact, retained explicit-client terminal observation. Retryable transport loss is distinguishable from malformed/protocol terminal failures; late terminal subscribers receive the same retained error once, and disposal cannot replace it.
- Added a separate `ReconnectingMusicSessionClient` contract with retained state/status, current generation metadata, lifecycle subscription/state, immediate no-queue commands, and asynchronous idempotent disposal.
- Added a scoped Effect supervisor (`createReconnectingMusicSessionClientEffect`) plus Promise owner. It reuses `connectOrStartMusicSessionEffect` for every initial/replacement generation, fences callbacks by a monotonically increasing token, retains A state during reconnect, adopts B replay across lower revisions, and rejects unavailable commands instead of replaying them.
- Exported only the host-neutral reconnecting constructor and types from `packages/music-core/index.ts`.
- Added real Unix selected-server integration evidence for A → loss → B: indeterminate blocked A command, retained state during reconnect, lower-revision B replay, no replay on B, lifecycle ordering, listener isolation, and idempotent disposal. Added explicit terminal-observation coverage.

## Files touched

- `packages/music-core/session/client.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/session-client.test.ts`
- `.apnea/artifacts/phase-04/round-1/coder-result.md`

## Verify transcript

```text
$ bunx nx run music-core:typecheck
exit 0
NX Successfully ran target typecheck for project music-core

$ bun test packages/music-core/tests/session-client.test.ts -t 'terminal observation|reconnect|replacement generation|indeterminate'
exit 0
4 pass, 0 fail
26 expect() calls

$ bun test packages/music-core/tests/session-client.test.ts -t 'reconnect|replacement generation|indeterminate'
exit 0
3 pass, 0 fail

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
88 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
218 pass, 0 fail
913 expect() calls
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts
exit 0

$ test ! -e "/tmp/naxodev-music-$(id -u)/s.sock"
exit 0

$ jj diff --summary
exit 0
M packages/music-core/index.ts
M packages/music-core/session/client.ts
M packages/music-core/tests/session-client.test.ts
(unrelated pre-existing phase metadata/tasks and .apnea/state.json remain dirty and untouched)

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/protocol.ts packages/music-core/index.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
Only the allowed Phase 4 index/client/test paths changed; config/protocol/server-test were unchanged by this phase.

$ git diff --check
exit 0
```

## Residual risks

- Intentional injected cleanup and marker-release tests still emit bounded warnings during the suite; all verification commands exit successfully.
- No commit, push, or `.apnea/state.json` edit was performed.
