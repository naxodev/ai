---
status: done
---

## Changes

- Added config-owned `idleGraceMs` with a positive-safe-integer validation boundary and a 30-second production default, separate from provider `pollMs.idle`.
- Added a single server-scoped serialized join/leave queue and Effect `sleep` supervisor. Only a compatible negotiated hello joins; the connection scope submits its one leave from its finalizer.
- The supervisor starts an initial zero-client grace, cancels the live sleep on join, starts a fresh grace on the last leave, and completes a server-owned idle Deferred exactly once on expiry.
- Exposed `awaitIdle` only through the internal server service. Both the daemon foreground and Promise compatibility lifetime race idle alongside their existing signal/close/fault paths, so normal idle exit uses the existing selected graph finalizer.
- Added bounded lifecycle hooks for client count and idle grace state. Hook errors are isolated.
- Added focused config coverage plus a real selected Layer/TestClock test proving initial grace, no early expiry, exact single expiry, and selected listener/provider cleanup.

## Files touched

- `packages/music-core/session/config.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-05/round-1/coder-result.md`

No commit, push, `.apnea/state.json`, protocol, provider, coordinator, public index, package configuration, docs, or host changes were made.

## Verification

```text
$ bunx nx run music-core:typecheck
exit 0

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t 'idle|last client|grace'
exit 0
1 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
exit 0
98 pass, 0 fail
551 expect() calls

$ NX_SKIP_NX_CACHE=true bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
228 pass, 0 fail
966 expect() calls
Verified npm package contents (21 files)

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/session/client.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The successful suites retain existing intentional injected cleanup/marker-release warnings.

## Residual risks

- The package's broader real-socket matrix (pre-hello/malformed pinning, two-client last-leave/rejoin behavior, signal-versus-idle, child executable idle exit, and reconnect A-to-B idle replacement) remains unproven by focused new tests.
- Existing reconnect behavior was not changed; no reconnect-specific idle integration test was added.
- Pre-existing `.apnea` task/package metadata and `.apnea/state.json` remain dirty and untouched.
