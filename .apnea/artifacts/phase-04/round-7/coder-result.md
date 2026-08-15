---
status: done
---

## Changed

Added the narrow managed-runtime observation seam and focused conservative coverage:

- `RuntimeDependencies` provides per-runtime test overrides for `lstat`, `mkdir`, marker reads, unlink, and process-existence observation; production retains real Node filesystem calls and `process.kill(pid, 0)`.
- Added failure-safe tests proving wrong-mode and symlinked runtime roots are rejected without repair, unsafe regular-file socket artifacts are retained, and an injected `EPERM` marker process observation remains `starting` with no cleanup authority.

Files touched:

- `packages/music-core/session/config.ts`
- `packages/music-core/tests/session-client.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
51 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
181 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- Additional Phase 4 security-matrix cases (foreign ownership, stale replacement, malformed peers, and executable behavior) remain for further review.
- No process launch, retry, reconnect, or idle-shutdown behavior was added.
