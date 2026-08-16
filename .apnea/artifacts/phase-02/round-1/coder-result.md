---
status: done
---

## What changed

Updated the OpenCode packed-package smoke to create its unique temporary root before packing both archives, install the exact source-manifest OpenCode CLI pin with temporary-project-only CLI trust, and launch only its realpathed isolated binary. The smoke now verifies installed CLI/plugin versions, isolated packed plugin/core package-name resolution, keeps the existing deterministic UI scenarios, and confirms exact tmux termination before removing the root.

## Files touched

- `packages/opencode-music-player/scripts/package-smoke.ts`
- `.apnea/artifacts/phase-02/round-1/coder-result.md`

## Verification transcript

```text
$ bunx nx run opencode-music-player:smoke --skip-nx-cache
exit: 0
> nx run opencode-music-player:smoke
> bun run smoke:package
$ bun run scripts/package-smoke.ts
installed OpenCode 0.0.0-next-17386: /private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-music-player-smoke-reAwJp/node_modules/@opencode-ai/cli/bin/opencode2.exe
isolated packed resolutions: plugin=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-music-player-smoke-reAwJp/node_modules/@naxodev/opencode-music-player/index.tsx; core=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-music-player-smoke-reAwJp/node_modules/@naxodev/music-core/index.ts
OpenCode loaded the installed package and rendered its app and sidebar slots.
OpenCode package smoke cleanup: ok
NX Successfully ran target smoke for project opencode-music-player

$ ! find packages/opencode-music-player -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
exit: 0
(no output; no prohibited package-directory artifacts found)

$ jj diff --summary
exit: 0
tail:
M .apnea/state.json
A .apnea/tasks/code-p2-r1-1786918649558.md
A .apnea/tasks/phase_package-p2-r1-1786918545319.md
M packages/opencode-music-player/scripts/package-smoke.ts

$ jj status
exit: 0
tail:
M .apnea/state.json
A .apnea/tasks/code-p2-r1-1786918649558.md
A .apnea/tasks/phase_package-p2-r1-1786918545319.md
M packages/opencode-music-player/scripts/package-smoke.ts
Working copy  (@) : ornnkvpk 9126ce88 (no description set)
Parent commit (@-): kyzluvzy 863c6e7b test(music): verify packed daemon under Node
```

## Residual risks

The machine-local smoke requires Bun, npm, tmux, and availability of the exact pinned OpenCode package. All generated content is scoped to the smoke root and its unique tmux socket; successful verification reported cleanup. Existing unrelated `.apnea` changes, including `.apnea/state.json`, were preserved and not edited.
