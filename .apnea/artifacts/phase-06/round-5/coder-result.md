---
status: done
---

## Changed

- Added a subprocess-isolated oversized provider-state regression. It exercises the real selected graph and encode/local-close path without allowing a Bun runtime fault to terminate the parent test runner.
- The child asserts exactly one bounded outbound-overflow observation, closure of the oversized peer, continued selected-coordinator command execution, and bounded child cleanup. A nonzero child exit is surfaced with its stderr in the parent test.

## Files touched

- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-06/round-5/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t '24|slow reader|backpressure|overflow|oversized'
exit 0
6 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0
135 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
242 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts
exit 0

$ jj diff --summary
exit 0
inspected current phase paths; `.apnea/state.json` remained pre-existing and untouched

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/protocol.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/framing.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0
inspected (1327 lines)

$ git diff --check
exit 0
```

One full-matrix run hit existing timing-sensitive process tests under load; the immediate rerun passed all 242 tests.

## Residual risks

- The oversized fixture verifies selected-graph survival through its coordinator command after local peer containment. With a server-global frame limit, the same oversized provider payload cannot simultaneously remain deliverable to a second state-replay peer; healthy-peer fan-out continuity is covered separately by the bounded fan-out and slow-reader cases.
- No commit, push, or `.apnea/state.json` edit was performed.
