---
status: done
---

## Result

No product change was retained. The current Phase 5 graph contract combines provider and coordinator ownership, so a finalizer reorder cannot safely break the reproduced selected-topology cancellation cycle. The required repair is the package-authorized atomic graph migration across server, executable, and test seams.

## Verify transcript

Previous unchanged-source verification:

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

- Selected listener-first shutdown deadlock remains reproduced.
- Required process-level singleton, startup scheduling/convergence, marker-release, and skew-race acceptance coverage remains missing.
- No commit, push, or `.apnea/state.json` edit was performed.
