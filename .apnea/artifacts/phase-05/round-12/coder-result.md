---
status: done
---

## Investigation

No product change was retained this round.

The blocked-sampling fixture was temporarily moved to the actual selected `layerWithHooks(..., coordinatorGraph)` topology. Closing its scope deterministically timed out after 5 seconds, confirming the reported production ownership cycle. The test was restored to its external composition rather than committing a failing regression.

The attempted fixes that close the nested coordinator scope before joining connection children break established lifecycle disposal assertions: the provider's disposal finalizer is no longer observed. The required solution is a real ownership-scope split (listener, coordinator interruption, and provider finalization), not a finalizer reorder.

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

- Selected listener-first shutdown has a reproduced coordinator/connection cancellation deadlock.
- Process-level bind/hello/non-interference, TestClock startup, 20-way convergence, spawn-release diagnostics, and skew-race coverage remain outstanding.
- No commit, push, or `.apnea/state.json` edit was performed.
