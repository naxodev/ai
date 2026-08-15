---
status: done
---

## Changed

- Made the real stale-socket fixture failure-safe: listener acquisition is tracked and any still-open listener is closed in `finally`.
- Added discovery-level disjoint protocol-range coverage. It verifies an incompatible result retains both range details, grants no cleanup, preserves socket identity, and permits a subsequent supported managed client.
- Extended stale replacement coverage to preserve both regular-file and symlink replacements.

Files touched:

- `packages/music-core/tests/session-client.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
54 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
184 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- Conservative malformed/reset peer tests, remaining marker/artifact matrix, managed-server hardening, and executable matrix cases remain for further Phase 4 review.
- No process launch, retry, reconnect, or idle-shutdown behavior was added.
