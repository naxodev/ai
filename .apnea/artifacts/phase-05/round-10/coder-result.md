---
status: done
---

## Changed

Made bind-reservation publication crash-safe in `packages/music-core/session/server.ts`:

- Write and sync the complete PID/UID reservation to a unique private temporary file.
- Atomically publish it with `link(temporaryPath, reservationPath)`, which fails exclusively if a contender already owns the reservation.
- Remove the temporary link only after publication; any crash before publication leaves an inert uniquely named temporary file, never an empty/malformed authoritative reservation.
- Preserve exact device/inode/UID cleanup for both temporary and published paths, plus existing proven-dead reservation recovery.

Files touched:

- `packages/music-core/session/server.ts`

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

- Bind-reservation policy still belongs in `server.ts`, rather than the config/discovery boundary requested by review.
- A crash before temporary cleanup can leave an inert unique temporary file; it cannot block later reservation publication.
- Selected listener-first shutdown still has the coordinator/connection wait cycle.
- Process-level bind/hello/non-interference, TestClock startup, 20-way convergence, spawn-release diagnostics, and skew-race coverage remain outstanding.
- No commit, push, or `.apnea/state.json` edit was performed.
