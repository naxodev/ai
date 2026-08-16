---
status: done
---

## Changed

Implemented the Phase 4 managed runtime/discovery slice.

- Added compact per-UID runtime path resolution, typed runtime failures, owner-only directory/socket/marker inspection, bounded marker decoding, identity-checked stale cleanup, and a narrow test runtime seam in `config.ts`.
- Added one-shot managed endpoint discovery in `client.ts`; only completed hello produces healthy/incompatible outcomes, and refusal with a revalidated identity produces guarded stale cleanup.
- Hardened server bind/finalization to prepare managed directories, chmod/capture the bound socket, and unlink only the captured device/inode identity.
- Made daemon socket selection optional, selecting the managed default without spawning or startup coordination, while preserving absolute explicit overrides and tagged path diagnostics.
- Added focused managed resolver/discovery and managed-server ownership tests.

Files touched:

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
45 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
175 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/config.ts
M packages/music-core/session/music-sessiond.ts
M packages/music-core/session/server.ts
M packages/music-core/tests/session-client.test.ts
M packages/music-core/tests/session-server.test.ts

$ git diff --check
exit 0
```

The server suite's intentional injected unlink-failure case logs its expected warning while exiting successfully.

## Residual risks

- A post-verification isolated rerun of three pre-existing system-provider server cases timed out after Bun reported dangling media-control processes; the complete focused and full runs above passed before the final diagnostics-only formatting change. Final TypeScript check, static spawn scan, and diff check passed after that change.
- Managed marker creation/startup arbitration, spawning, retries, reconnect, and idle shutdown remain intentionally deferred to later phases.
