---
status: done
---

## Changed

Added managed discovery coverage for conservative protocol-peer failures:

- Uses real managed Unix listeners that either emit malformed hello data or reset the connection.
- Verifies both classify as `occupied`, expose no cleanup authority, preserve the socket artifact, and observe probe-socket closure.
- Listener setup and teardown are failure-safe within each fixture iteration.

Files touched:

- `packages/music-core/tests/session-client.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
55 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
185 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- Remaining artifact/marker matrix, managed-server hardening, and executable-selection matrix cases remain for Phase 4 review.
- No process launch, retry, reconnect, or idle-shutdown behavior was added.
