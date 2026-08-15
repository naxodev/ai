---
status: done
---

## Investigation

No product change was retained.

The review requires a graph-contract migration, not an ordering patch: `layerWithHooks` currently accepts a combined coordinator/provider graph. The selected graph demonstrates the cancellation cycle, while closing its current nested scope early also changes provider finalization behavior. A correct repair must make the selected graph constructor accept/build distinct provider and coordinator scopes, update the executable and every graph seam atomically, then retain the selected-topology blocked test. This exceeds a safe targeted rework without a new/updated phase package defining that interface migration.

## Verify transcript

Previous unchanged-source verification remains green:

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
73 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
203 pass, 0 fail

$ git diff --check
exit 0
```

## Residual risks

- Selected listener-first shutdown has a reproduced coordinator/connection cancellation deadlock.
- Process-level bind/hello/non-interference, TestClock startup, 20-way convergence, spawn-release diagnostics, and skew-race coverage remain outstanding.
- No commit, push, or `.apnea/state.json` edit was performed.
