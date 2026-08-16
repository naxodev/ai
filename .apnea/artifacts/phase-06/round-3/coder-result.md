---
status: done
---

## Changed

- Made bounded inbound/outbound/backpressure observations connection-identifiable through socket-only lifecycle hooks; hooks carry no frame, command, or playback payload.
- Proved the specifically paused writer reaches real Node backpressure, coalesces state for that same connection, and does not prevent ordered healthy-client command results before its mandatory lane is overflowed and locally closed.
- Added deterministic blocked-request inbound-chunk-queue flood coverage, including exact-once local overflow, healthy state continuity, and later command-worker use.
- Gated each cross-client command submission on its observed admission, making the FIFO/`SERVER_BUSY` recovery test independent of Unix socket scheduling.
- Extended reconnect coverage with `maxPendingRequests: 1`: the wrapper delegates the local bound and does not queue/replay the rejected command across generations.

## Files touched

- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-06/round-3/coder-result.md`

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
inspected (1214 lines)

$ git diff --check
exit 0
```

The first NX matrix attempt hit the existing timing-sensitive 20-concurrent-managed-callers test; the immediate rerun passed the complete 241-test matrix. Existing injected cleanup-failure fixtures continue to emit expected warnings.

## Residual risks

- A focused provider-derived oversized-outbound real-socket test triggered a Bun 1.3.7 segmentation fault (`Trace/BPT trap`) in isolation, so it was removed rather than leave a crashing test. The server-side `encode`/local-close containment remains in place; this case still needs a stable runtime-level regression fixture.
- No commit, push, or `.apnea/state.json` edit was performed.
