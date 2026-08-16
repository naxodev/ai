---
status: done
---

## Changed

- Added the missing real paused-reader acceptance: a negotiated raw Unix peer reaches actual Node write backpressure, coalesces later state locally, then overflows only its mandatory lane while twenty-three alternating OpenCode/Pi clients converge and remain command-capable.
- Added real multi-client global command-lane FIFO/`SERVER_BUSY` overflow/recovery coverage.
- Validated `maxPendingRequests` before opening a socket and covered zero, negative, fractional, non-finite, and unsafe values.
- Made decoded-frame limiting stop during framing, before an oversized decoded-frame array is created; this narrowly touches `framing.ts`, as required for the server bound.
- Made outbound send paths no-op after local closure so an overflowing connection emits one bounded diagnostic rather than repeatedly reporting subsequent queued frames.
- Made 24-client startup retain all fulfilled clients before surfacing aggregate failures, and asserted negotiated capability equality.
- Expanded new configuration-bound validation cases.

## Files touched

- `packages/music-core/session/client.ts`
- `packages/music-core/session/config.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-06/round-2/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t '24|slow reader|backpressure|overflow'
exit 0
4 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0
133 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
240 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts
exit 0

$ jj diff --summary
exit 0
inspected current phase paths; `.apnea/state.json` remained pre-existing and untouched

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/protocol.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/framing.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0
inspected (1039 lines)

$ git diff --check
exit 0
```

The first full-matrix attempt hit the pre-existing timing-sensitive 20-concurrent-managed-callers test; isolated repetition passed five times and the immediately repeated full NX matrix passed (240 tests). Existing injected cleanup-failure fixtures continue to emit expected warnings.

## Residual risks

- The backpressure test intentionally uses real local Unix-socket buffering and a large, in-limit state frame; its exact write count is platform-dependent, while the hook is the deterministic assertion barrier.
- No commit, push, or `.apnea/state.json` edit was performed.
