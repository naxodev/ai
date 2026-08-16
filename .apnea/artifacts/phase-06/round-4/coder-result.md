---
status: done
---

## Changed

- Added socket-identified writer blocked/unblocked lifecycle observations around the interruptible drain wait.
- Tightened the paused-reader proof: the test now asserts that the exact slow writer remains blocked while the other twenty-three clients converge and while ordered healthy-client commands settle, before local mandatory-lane overflow.
- Added final 24-client bind-lock/temporary-reservation residue assertions.

## Files touched

- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-06/round-4/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t '24|slow reader|backpressure|overflow|chunk|reconnecting client adopts one replacement'
exit 0
7 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0
134 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
241 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts
exit 0

$ jj diff --summary
exit 0
inspected current phase paths; `.apnea/state.json` remained pre-existing and untouched

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/protocol.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/framing.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0
inspected (1241 lines)

$ git diff --check
exit 0
```

## Residual risks

- Retrying a focused provider-derived oversized-state real-socket test still crashes Bun 1.3.7 (`Trace/BPT trap`) before a test result. The server's local frame-size containment remains implemented, but this required regression case needs a stable runtime fixture or a Bun runtime fix.
- No commit, push, or `.apnea/state.json` edit was performed.
