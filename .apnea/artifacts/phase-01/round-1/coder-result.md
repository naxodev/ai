---
status: done
---

Implemented the selected production graph split: provider and coordinator now build once in separate child scopes after listener hardening; shutdown closes coordinator, drains connections, closes provider, then releases listener/path. `layerWithHooks` and the Promise adapter now accept provider layers only. Added selected-topology blocked-command evidence with real Unix client, ordering hooks, interruption, exact-once finalization, indeterminate settlement, and no late write.

Files changed for this phase:
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-server.test.ts`

Verification:

```text
$ bun test packages/music-core/tests/session-server.test.ts -t 'selected.*blocked|blocked.*selected'
exit: 0
(pass) selected graph shutdown interrupts blocked coordinator work before draining connections
1 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts
exit: 0
35 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit: 0
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core
203 pass, 0 fail

$ ! rg -n 'Effect\.runSync|setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit: 0

$ jj diff --summary
exit: 0
Inspected: phase paths remain limited to server, daemon, and server-test alongside pre-existing dirty worktree files.

$ jj diff --git packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/tests/session-server.test.ts
exit: 0
Inspected: provider-only selection, separate scopes, and coordinator -> connections -> provider -> listener order are present.

$ git diff --check
exit: 0
```

Residual risks: none identified for the Phase 1 selected shutdown topology. Existing unrelated dirty worktree changes (including `.apnea/state.json`) were not modified.
