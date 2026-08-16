---
status: done
---

## Changed

- Narrowed session artwork disposal cleanup: pending and null-result retry entries owned by a released adapter are removed, while successful settled artwork remains shared for later controller generations.
- Cleared the released worker ownership on preserved successful cache entries so later disposal cannot evict them.
- Added overlapping A-success → B-cache-hit → A-dispose coverage proving B retains its artwork and does not issue a replacement native request.

Files touched:

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`

## Verification

```text
$ bun --cwd packages/opencode-music-player test --preload @opentui/solid/preload tests/system-media.test.ts tests/controller.test.ts tests/controller-lifecycle.test.ts tests/artwork-lifecycle.test.ts
exit 0 — focused suite passed.

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
exit 0 — all targets passed; music-core 259 pass, opencode-music-player 164 pass.

$ jj diff --summary
exit 0 — inspected accumulated dirty baseline and phase paths.

$ git diff --check
exit 0

$ rg -n 'createBackend: createSystemMedia|createSessionSystemMedia|media-control.*get.*--now' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0 — production remains direct; only the direct adapter invokes media-control get --now.
```

## Residual risks

- Production selection intentionally remains `createSystemMedia` until Phase 9.
- Existing unrelated dirty `.apnea/state.json` was not edited.
