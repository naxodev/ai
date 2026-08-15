---
status: done
---

## Changed

Extended the deterministic partial-hardening failure test to prove all acquired resources finalize:

- pre-creates an unrelated runtime-directory file and verifies partial cleanup preserves it;
- uses a tracked fake provider and verifies its disposer runs exactly once after the failed scoped startup;
- retains existing assertions for tagged hardening failure, listener closure, exact partial socket removal, and directory retention.

Files touched:

- `packages/music-core/tests/session-server.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
60 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
190 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- Remaining ownership/disappearance and executable-selection matrix cases remain for Phase 4 review.
- No process launch, retry, reconnect, or idle-shutdown behavior was added.
