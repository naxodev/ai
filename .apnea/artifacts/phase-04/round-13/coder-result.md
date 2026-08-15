---
status: done
---

## Changed

Extended invalid-marker coverage with:

- oversized marker input;
- schema-valid marker JSON whose UID differs from the runtime UID.

Both fail closed and retain the original artifact, alongside the existing malformed, mode, symlink, and non-regular cases.

Files touched:

- `packages/music-core/tests/session-client.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
58 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
188 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- Remaining foreign-ownership/disappearance coverage, managed-server hardening, and executable-selection matrix cases remain for Phase 4 review.
- No process launch, retry, reconnect, or idle-shutdown behavior was added.
