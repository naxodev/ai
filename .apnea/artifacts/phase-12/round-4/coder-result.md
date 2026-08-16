---
status: done
---

## Changed

- Made process-group termination idempotent: `ESRCH` is treated as already exited, successful/nonzero harness paths await group disappearance, and original harness diagnostics are preserved.
- Added a distinct unconfirmed-group failure path. The smoke root is retained (and printed) rather than removed if exact process-group termination cannot be proven.
- Closed the pending-startup ownership gap: cleanup stops the exact daemon boundary first, then awaits the retained acquisition to its terminal result and disposes a late client before cleanup completes.
- Preserved the Node built-in TypeScript loader, installed-package lifecycle, package surface, and existing Phase 12 boundaries.

Files touched:

- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/session/music-sessiond.ts`

## Verification

```text
$ bunx nx run music-core:smoke --skip-nx-cache
exit 0
installed Node v24.8.0
installed package root: .../install/node_modules/@naxodev/music-core/index.ts
manifest daemon: .../install/node_modules/@naxodev/music-core/dist/music-sessiond.js
negotiated daemon: music-session-... revision 1
status-zero idle exit and cleanup: ok

$ bunx nx run music-core:package:check --skip-nx-cache
exit 0
Verified npm package contents (21 files)

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core --skip-nx-cache
exit 0
music-core: 261 pass, 0 fail

$ ! find packages/music-core -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
exit 0

$ git diff --check && jj diff --summary && jj status
exit 0
```

## Residual risks

- The phase package still conflicts: it requires calling installed `resolveMusicSessionRuntimePaths` but forbids both the root export and package-export change required for an importable config surface. Node package export encapsulation prevents importing `session/config.ts` by package specifier. The harness retains the explicit temporary supplied-runtime boundary pending a package decision.
- If exact harness-process-group termination cannot be proven, the verifier intentionally retains its unique temporary root rather than deleting files below a potentially live child; it prints that root for recovery.
- `.apnea/state.json` was already dirty and was not edited.
