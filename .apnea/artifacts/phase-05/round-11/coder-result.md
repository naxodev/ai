---
status: done
---

## Changed

Hardened reservation failure handling and returned singleton authority to the socket:

- If cleanup after a successful atomic reservation publication fails, acquisition now closes its descriptor and exact-identity cleans the published reservation as well as the temporary link before failing.
- Releases the bind reservation immediately after successful listener bind and `0600` hardening. Later contenders serialize only until they can observe the bound socket; the socket remains the long-lived singleton authority.
- Updated stale-reservation coverage to assert that a successful live bind no longer retains the sidecar.

Files touched:

- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-server.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
73 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
203 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "setTimeout\\(|setInterval\\(|Bun\\.sleep" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ git diff --check
exit 0
```

Focused/full verification emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both commands exited successfully.

## Residual risks

- Bind-reservation policy remains in `server.ts`, not the requested config/discovery boundary.
- Selected listener-first shutdown still has the coordinator/connection wait cycle.
- Process-level bind/hello/non-interference, TestClock startup, 20-way convergence, spawn-release diagnostics, and skew-race coverage remain outstanding.
- No commit, push, or `.apnea/state.json` edit was performed.
