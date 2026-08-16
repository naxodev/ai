---
status: done
---

## Changed

Closed the remaining managed-artifact and executable-boundary evidence gaps:

- Added deterministic rejection/preservation coverage for non-directory and simulated foreign-owned runtime roots; symlinked and wrong-mode socket artifacts; and simulated foreign socket/marker ownership with no unlink capability.
- Added refusal-after-disappearance coverage: a pre-inspected stale socket that disappears after the real no-listener attempt becomes `missing`, not stale.
- Changed the injectable daemon graph seam to receive `MusicSessionOptions`, so tests exercise the real default-versus-explicit selection boundary.
- Added executable tests proving a no-flag invocation supplies managed runtime options, an absolute `--socket` stays explicit/unmanaged, each builds one graph, and tagged runtime failures retain operation/path/message diagnostics with nonzero status.

Files touched:

- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
65 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
195 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- The injected ownership seam is necessary because unprivileged tests cannot create foreign-owned artifacts.
- No startup coordination, spawning, retry, reconnect, or idle-shutdown behavior was added.
