---
status: done
---

## Changed

- Hardened installed-smoke subprocess ownership: stdout/stderr drain concurrently, timed-out harnesses run in an owned process group, SIGTERM escalates to SIGKILL, and the verifier confirms the group has exited before continuing cleanup.
- Kept a pending reconnecting-client acquisition owned through harness cleanup rather than dropping it when startup timeout wins. Cleanup now requires exact daemon termination before removing its runtime root.
- Removed the temporary TypeScript dev dependency and custom compiler. The temporary Node loader now uses Node's built-in `stripTypeScriptTypes`, so the isolated install has only the packed package as its application dependency.
- Added the negotiated protocol revision to successful smoke output.
- Preserved the existing narrow package surface and package contents.

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

- The phase package simultaneously requires invoking installed `resolveMusicSessionRuntimePaths` and forbids both its root export and any package-export change. The current published root exposes no importable resolver, and Node export encapsulation prevents importing `session/config.ts` by package specifier. The harness therefore retains the prior explicit temporary runtime layout; satisfying the unresolved resolver requirement needs a phase-package decision to permit a public export/subpath or to accept this explicit runtime boundary.
- `.apnea/state.json` was already dirty and was not edited.
