---
status: done
---

## Changed

Implemented the initial Phase 5 managed-launch foundation:

- Added exclusive, exact-owner startup marker leases with cryptographic attempt tokens, `wx` creation, owner-only marker validation, idempotent guarded release, and replacement refusal.
- Allowed discovery to ignore only the caller's exact owned marker during its post-lease probe.
- Added a detached packaged-daemon launcher boundary using absolute entry resolution, `stdio: "ignore"`, no shell, and exactly-once `unref` after spawn observation.
- Added `connectOrStartMusicSession` / `connectOrStart`, which probes first, preserves incompatible/occupied terminal behavior, uses guarded stale cleanup, acquires/releases a marker, and launches at most once.
- Added real marker-contention/replacement coverage and a real managed connect-or-start test using a launcher seam that starts the existing server over a Unix socket.

Files touched:

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
67 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
197 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "setTimeout\\(|setInterval\\(|Bun\\.sleep" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- Listener-first server topology and the full concurrent 20-client/bind-race matrix remain to be implemented.
- Startup timing defaults/configuration and a fully Effect-scoped pending-attempt workflow need completion; the current bounded schedule only paces valid foreign-marker waiting.
- Launcher spawn-option/error-listener tests and protocol-skew cases remain to be added.
