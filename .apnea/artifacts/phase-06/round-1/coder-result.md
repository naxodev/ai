---
status: done
---

## Changed

- Added validated server bounds for inbound chunks, decoded frames per chunk, and mandatory outbound frames, including environment configuration.
- Added explicit-client pending-request capacity with immediate `SERVER_BUSY` rejection and recovery after settlement.
- Replaced direct server writes with a per-connection scoped writer: bounded mandatory FIFO frames, latest-state coalescing, frame-size containment, and interruptible Node `drain` handling.
- Localized inbound burst overflow to the offending socket.
- Added real 24-client alternating OpenCode/Pi fan-out coverage, pending-client bound coverage, and overflow isolation coverage.

## Files touched

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-06/round-1/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t '24|slow reader|backpressure|overflow'
exit 0
3 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0
130 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
237 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts
exit 0

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/protocol.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0
inspected (697 lines)

$ git diff --check
exit 0
```

The full matrix emits expected injected cleanup-failure warnings from existing fixtures.

## Residual risks

- Node drain behavior remains platform-dependent, but its listener lifetime is scoped and outbound memory remains bounded while blocked.
- Pre-existing phase metadata and `.apnea/state.json` changes remain untouched. No commit or push was performed.
