---
status: done
---

## Investigation

No product change was retained this round.

The selected-topology blocked-sampling probe was reproduced again: passing the fixture’s `coordinatorWithProvider` graph directly as the second `layerWithHooks` argument makes `Scope.close` time out. The green fixture must remain externally composed until ownership is split.

The needed repair changes the graph contract: build the provider graph in a provider scope after listener bind, build `coordinatorLayer` from that resulting provider context in a distinct coordinator scope, close the coordinator scope before joining connection fibers, then close the provider scope after they complete. The current `layerWithHooks` parameter is already a combined coordinator/provider graph, so implementing this requires changing the shared graph constructor and every executable/test graph seam together. It was not safe to retain a partial graph-interface migration in this rework round.

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
