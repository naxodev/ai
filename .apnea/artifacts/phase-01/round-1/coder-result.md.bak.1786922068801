---
status: done
---

## What changed

No product-source change was needed. The existing dirty packed-core implementation satisfies this phase: the installed smoke imports `@naxodev/music-core`, selects the daemon from the installed manifest, supplies a unique structural runtime beneath its temporary root, validates invalid configuration, completes hello/replay, isolates providers, awaits disposal and bounded idle exit, and reports cleanup success. Package exports remain unchanged.

## Files touched

- `.apnea/artifacts/phase-01/round-1/coder-result.md`

No phase-owned product files were modified.

## Verification transcript

```text
$ bunx nx run music-core:smoke --skip-nx-cache
exit: 0
> nx run music-core:smoke
> bun run smoke:package
$ bun run scripts/verify-pack.ts --installed-smoke
installed Node v24.8.0
installed package root: /private/tmp/music-core-installed-smoke-tvOddD/install/node_modules/@naxodev/music-core/index.ts
manifest daemon: /private/tmp/music-core-installed-smoke-tvOddD/install/node_modules/@naxodev/music-core/dist/music-sessiond.js
negotiated daemon: music-session-z6lwf5z2lx revision 1
status-zero idle exit and cleanup: ok
NX Successfully ran target smoke for project music-core

$ ! find packages/music-core -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
exit: 0
(no output; no prohibited artifacts found)

$ jj diff --summary
exit: 0
tail:
M packages/music-core/package.json
M packages/music-core/project.json
M packages/music-core/scripts/verify-pack.ts
M packages/music-core/session/music-sessiond.ts

$ jj status
exit: 0
tail:
M packages/music-core/package.json
M packages/music-core/project.json
M packages/music-core/scripts/verify-pack.ts
M packages/music-core/session/music-sessiond.ts
Working copy  (@) : kyzluvzy 95deca42 (no description set)
Parent commit (@-): luotokos 31f1c2d4 chore(music): remove per-host provider ownership
```

## Residual risks

The verification is machine-local and depends on the installed Node/npm environment. Pre-existing unrelated worktree and `.apnea` changes were preserved; `.apnea/state.json` was not edited.
