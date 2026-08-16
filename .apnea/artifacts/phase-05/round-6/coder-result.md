---
status: done
---

## Changed

- Added validated, environment-backed `idleGraceMs` configuration.
- Made compatible-hello join ownership interruption-safe so an admitted join always has a matching connection-scope leave.
- Kept one server-scoped Effect idle supervisor and foreground idle races for daemon and compatibility lifetimes.
- Added TestClock real-socket coverage for initial grace, negotiated-client cancellation/restart, non-last departure, exact expiry, and non-client sockets.
- Added executable no-client idle-exit coverage with cleanup assertions.

## Files touched

- `packages/music-core/session/config.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-05/round-6/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t 'idle|last client|grace'
exit 0
3 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
exit 0
100 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
230 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/session/client.ts
exit 0

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/session/client.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
exit 0
inspected (615 lines)

$ git diff --check
exit 0
```

The full suite emits expected injected cleanup-failure warnings from existing server fixtures.

## Residual risks

- Existing reconnect-generation coverage remains the regression evidence for idle replacement; no second reconnect implementation was added.
- Pre-existing unrelated `.apnea` and state changes remain untouched. No commit, push, or `.apnea/state.json` edit was performed.
