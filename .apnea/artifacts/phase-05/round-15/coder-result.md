---
status: done
---

## Escalation

No product change was retained.

The Phase 5 graph migration is within the package, but it is not safely partially applicable: `layerWithHooks` must be changed from accepting a combined coordinator/provider graph to accepting a provider graph, then construct the coordinator in a child ownership scope. This requires coordinated changes to `server.ts`, `music-sessiond.ts`, all existing executable graph seams, and the server fixtures. The resulting lifecycle must close coordinator before joining connections, provider after connections, and listener last. The current combined graph cannot express that order; the selected-topology probe remains a deterministic timeout.

## Verify transcript

No source changed in this round. The last unchanged-source verification was:

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

- Selected listener-first shutdown remains deadlocked in the real selected topology.
- Required process-level bind race/non-interference and startup acceptance coverage remain absent.
- No commit, push, or `.apnea/state.json` edit was performed.
