---
status: done
---

## Rework status

No source change was made in this round. The latest review requires a phase-package decision before a conforming implementation exists:

1. the package requires calling installed `resolveMusicSessionRuntimePaths` by package name but forbids every export change needed to make that API importable; and
2. it requires both confirmed child termination before deletion and unconditional deletion when termination cannot be confirmed.

The current implementation retains the supplied unique runtime boundary and fail-safe reported-root behavior from prior rounds. Changing either policy without an amended phase package would violate an explicit constraint.

Files touched: none (other than this result artifact).

## Verification

```text
$ bunx nx run music-core:package:check --skip-nx-cache
exit 0
Verified npm package contents (21 files)

$ bunx nx run music-core:smoke --skip-nx-cache
exit 0
installed Node v24.8.0
installed package root: .../install/node_modules/@naxodev/music-core/index.ts
manifest daemon: .../install/node_modules/@naxodev/music-core/dist/music-sessiond.js
negotiated daemon: music-session-... revision 1
status-zero idle exit and cleanup: ok

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core --skip-nx-cache
exit 0
music-core: 261 pass, 0 fail

$ ! find packages/music-core -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
exit 0

$ git diff --check && jj diff --summary && jj status
exit 0
```

## Residual risks

- Approval remains blocked pending an amended Phase 12 package that selects an import/runtime policy and an unconfirmed-child cleanup policy.
- `.apnea/state.json` was already dirty and was not edited.
