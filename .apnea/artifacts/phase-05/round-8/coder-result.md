---
status: done
---

## Changed

- Retained a real pre-hello connection through idle expiry and asserted selected shutdown ordering: coordinator → connections → provider → listener/unlink.
- Made the join-transfer test destroy the accepted socket from the commit hook before hello response/forwarders, proving one matching leave under interruption.
- Made signal and idle ready at the same TestClock instant; signal wins once and graph owners finalize once. Defect precedence remains covered.
- Changed same-generation reconnect coverage to use `connectOrStartMusicSessionEffect`, wait past the canceled grace deadline, and assert A remains live with zero launcher calls.

## Files touched

- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-05/round-8/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t 'idle|last client|grace'
exit 0
7 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
exit 0
104 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
234 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/session/client.ts
exit 0

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/session/client.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
exit 0
inspected (1058 lines)

$ git diff --check
exit 0
```

The full matrix emits expected injected cleanup-failure warnings from existing fixtures.

## Residual risks

- No new residual Phase 5 behavior is known; existing Phase 1–4 regression coverage remains baseline evidence.
- Pre-existing unrelated `.apnea` and state changes remain untouched. No commit, push, or `.apnea/state.json` edit was performed.
