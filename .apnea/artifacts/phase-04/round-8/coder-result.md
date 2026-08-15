---
status: done
---

## Changed

Added real-resource stale endpoint coverage:

- Creates a real bound Unix socket, renames its path before listener shutdown to leave a deterministic no-listener socket fixture.
- Verifies refusal plus identity recheck yields guarded stale cleanup, cleanup is idempotent, and the socket is removed.
- Verifies cleanup rejects a regular-file replacement and preserves it.

Files touched:

- `packages/music-core/tests/session-client.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
53 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
183 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- Disjoint-range, malformed-peer, remaining artifact/marker, server hardening, and executable matrix cases remain for further Phase 4 review.
- No process launch, retry, reconnect, or idle-shutdown behavior was added.
