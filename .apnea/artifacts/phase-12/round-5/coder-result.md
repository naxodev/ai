---
status: done
---

## Changed

- Split pending-acquisition failure from late-client disposal failure. A late acquired client remains owned, disposal failure prevents runtime-root removal, and the outer exact process-group boundary performs final cleanup.
- Replaced post-exit-only output reads with concurrent incremental stream capture. Unconfirmed process-group failures now preserve bounded partial stdout/stderr alongside the original termination diagnostic.
- Retained all previous installed Node lifecycle, manifest daemon selection, invalid-config, protocol/replay, idle-exit, and package-surface behavior.

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

- The phase package still requires installed `resolveMusicSessionRuntimePaths` while prohibiting the root/subpath export necessary to import it. The harness therefore retains the supplied temporary runtime structure; resolving this needs an explicit package decision.
- If exact harness-group termination cannot be proven, the verifier retains and reports its unique temporary root rather than deleting below a possibly live process. This safety behavior conflicts with the package's unconditional failure-cleanup wording and needs a package policy decision.
- `.apnea/state.json` was already dirty and was not edited.
