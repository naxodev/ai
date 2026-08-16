---
status: done
---

## Changed

- Completed adapter/controller composition coverage for replay, lifecycle feedback, lower-revision replacement, optimistic transport, seek coalescing, terminal errors, and observer isolation.
- Expanded the deterministic public-client fake with held commands, artwork, and disposal seams; added acquisition failure and held late-work coverage.
- Fenced released artwork work before host fallback resolution, and added controller/lifecycle assertions for late callbacks, reconnects, artwork, and exact-once release.
- Added session artwork ownership coverage for replacement recordings while preserving existing volatile-provider-ID presentation behavior.

Files touched:

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/artwork-lifecycle.test.ts`

## Verification

```text
$ bun test --preload @opentui/solid/preload packages/opencode-music-player/tests/system-media.test.ts packages/opencode-music-player/tests/controller.test.ts packages/opencode-music-player/tests/controller-lifecycle.test.ts packages/opencode-music-player/tests/artwork-lifecycle.test.ts
exit 1
error: preload not found "@opentui/solid/preload"

$ bun --cwd packages/opencode-music-player test --preload @opentui/solid/preload tests/system-media.test.ts tests/controller.test.ts tests/controller-lifecycle.test.ts tests/artwork-lifecycle.test.ts
exit 0
70 pass
0 fail
280 expect() calls

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
exit 0
NX Successfully ran targets typecheck, test, format:check, package:check for 2 projects
music-core: 259 pass, 0 fail
opencode-music-player: 170 pass, 0 fail

$ git diff --check
exit 0

$ rg -n 'createBackend: createSystemMedia|createSessionSystemMedia|media-control.*get.*--now' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0
packages/opencode-music-player/index.tsx:107:  createBackend: createSystemMedia,
packages/opencode-music-player/system-media.ts:338:        const result = await runCmd(["media-control", "get", "--now"])
packages/opencode-music-player/system-media.ts:416:export function createSessionSystemMedia(

$ jj diff --summary
exit 0
Inspected accumulated phase worktree summary; only allowed OpenCode paths were edited for this rework. Existing unrelated .apnea artifacts/tasks and .apnea/state.json remain dirty and untouched.
```

## Residual risks

- The exact root focused command cannot resolve the workspace preload from repository root; the package-cwd equivalent and full Nx package test pass.
- Production selection intentionally remains direct `createSystemMedia` until Phase 9.
