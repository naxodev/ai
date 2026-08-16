---
status: done
---

## Changed

Addressed every Phase 3 round-1 review finding in `packages/music-core/tests/session-client.test.ts`.

- Expanded deterministic `TestClock` coverage of the production startup workflow: immediate attempt, no early retry, seeded jitter/exponential intervals and cap, typed timeout at the exact attempt cap, success before exhaustion with no later attempt, and interruption while the scheduled sleep is pending.
- Added complete workflow-finalization coverage for launcher rejection, primary timeout plus secondary release failure, and a replaced marker inode/token. The release-only-success case now wraps the real handshaken client and proves it is disposed.
- Made the 20-client test await every caller with `Promise.allSettled` before cleanup and verify that no bind-lock or temporary reservation remains.
- Strengthened all incompatibility race positions to retain an already-supported client through the race, capture socket identity before the terminal outcome, assert negotiated range details, and prove terminal workflows make no further probes. Added the required returned-client live-loss assertion that it never relaunches.

No production source was changed in this rework. The existing Phase 3 `client.ts` and `config.ts` changes remain intact.

## Files touched

- `packages/music-core/tests/session-client.test.ts`
- `.apnea/artifacts/phase-03/round-2/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts -t 'TestClock|20 concurrent|marker.*release|launcher rejection|primary startup|incompatib|does not relaunch'
exit 0
12 pass, 0 fail

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
85 pass, 0 fail

$ bunx nx run music-core:typecheck
exit 0
NX Successfully ran target typecheck for project music-core

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
215 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts
exit 0

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/config.ts
M packages/music-core/tests/session-client.test.ts
(unrelated pre-existing phase artifacts/tasks and .apnea/state.json remain dirty and untouched)

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
Only the existing Phase 3 config/client work and session-client tests appear in the inspected package paths.

$ git diff --check
exit 0
```

## Residual risks

- Focused/full runs emit intentional bounded warnings for injected marker-release failures and the existing injected server-unlink failure; all commands exit successfully.
- No commit, push, or `.apnea/state.json` edit was performed.
