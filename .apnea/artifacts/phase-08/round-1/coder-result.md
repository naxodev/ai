---
status: done
---

## Changed

- Added `createSessionSystemMedia`, a one-client OpenCode adapter over the public reconnecting session-client contract. It projects replay/live state, lifecycle messages, controls, and native artwork into the existing host artwork resolver/presentation path without provider sampling or direct native artwork reads.
- Added optional asynchronous backend disposal and made controller disposal fence lifecycle work, tear down listeners, and safely release the backend.
- Kept the default production selector as `createBackend: createSystemMedia`.
- Added deterministic public-contract session-client fake coverage for one-shot acquisition, lower-revision replacement replay, controls, native artwork identity, and late-client disposal; added controller backend-release ordering coverage.

Files touched:

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`

## Verification

```text
$ bun --cwd packages/opencode-music-player test --preload @opentui/solid/preload tests/system-media.test.ts tests/controller.test.ts tests/controller-lifecycle.test.ts tests/artwork-lifecycle.test.ts
exit 0 — 54 pass, 0 fail

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
exit 0 — all targets passed; music-core 259 pass, opencode-music-player 153 pass

$ jj diff --summary
exit 0 — inspected phase paths and pre-existing dirty baseline

$ git diff --check
exit 0

$ rg -n 'createBackend: createSystemMedia|createSessionSystemMedia|media-control.*get.*--now' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0 — default remains direct; only the direct adapter contains `media-control get --now`
```

The package's root-level preload command cannot resolve `@opentui/solid/preload` from the repository root in this checkout; the package-cwd equivalent above and the Nx target both resolve and execute it.

## Residual risks

- Phase 9 must select the adapter in production; this phase intentionally leaves direct backend selection unchanged.
- `.apnea/state.json` was not edited.
