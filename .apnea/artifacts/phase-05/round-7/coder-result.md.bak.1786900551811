---
status: done
---

## Changed

No additional source edit was retained in this rework round. The current dirty Phase 5 worktree already has crash-safe bind-reservation publication: it writes and syncs a unique private temporary file, publishes it exclusively with `link`, exact-identity-cleans both names, recovers only proven-dead reservations, and releases the reservation after successful bind/hardening. Thus a partial reservation cannot become a persistent singleton authority.

## Files touched

- `.apnea/artifacts/phase-05/round-7/coder-result.md`

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

$ jj diff --summary && git diff --check
exit 0
```

Focused/full tests emit the expected injected unlink-failure warning from the server fixture and still exit successfully.

## Residual risks

- Selected listener-first shutdown still awaits connection children before selected coordinator closure, leaving the blocked coordinator/connection cycle unresolved.
- Bind-race evidence is same-process; process-level winner hello and non-interference remain unproven.
- Deterministic startup scheduling, 20-way convergence, exact spawn/interruption marker release, release diagnostics, and skew-race evidence remain incomplete.
- No commit, push, or `.apnea/state.json` edit was performed.
