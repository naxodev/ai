---
status: done
---

## What changed

Addressed the Phase 2 cleanup review finding in `package-smoke.ts`. Cleanup now always inspects and terminates the exact unique tmux socket before removing the smoke root, including after a failed `new-session`. It distinguishes a confirmed absent server from an unconfirmed tmux inspection error; the latter fails cleanup and retains/reports the root rather than deleting under a potentially live host.

## Files touched

- `packages/opencode-music-player/scripts/package-smoke.ts`
- `.apnea/artifacts/phase-02/round-2/coder-result.md`

## Verification transcript

```text
$ bunx nx run opencode-music-player:smoke --skip-nx-cache
exit: 0
> nx run opencode-music-player:smoke
> bun run smoke:package
$ bun run scripts/package-smoke.ts
installed OpenCode 0.0.0-next-17386: /private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-music-player-smoke-w0p0US/node_modules/@opencode-ai/cli/bin/opencode2.exe
isolated packed resolutions: plugin=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-music-player-smoke-w0p0US/node_modules/@naxodev/opencode-music-player/index.tsx; core=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-music-player-smoke-w0p0US/node_modules/@naxodev/music-core/index.ts
OpenCode loaded the installed package and rendered its app and sidebar slots.
OpenCode package smoke cleanup: ok
NX Successfully ran target smoke for project opencode-music-player

$ ! find packages/opencode-music-player -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
exit: 0
(no output; no prohibited package-directory artifacts found)

$ jj diff --summary
exit: 0
tail:
A .apnea/tasks/code-p2-r2-1786919000830.md
A .apnea/tasks/code_review-p2-r1-1786918847843.md
A .apnea/tasks/phase_package-p2-r1-1786918545319.md
M packages/opencode-music-player/scripts/package-smoke.ts

$ jj status
exit: 0
tail:
A .apnea/tasks/code-p2-r2-1786919000830.md
A .apnea/tasks/code_review-p2-r1-1786918847843.md
A .apnea/tasks/phase_package-p2-r1-1786918545319.md
M packages/opencode-music-player/scripts/package-smoke.ts
Working copy  (@) : ornnkvpk cf4112ef (no description set)
Parent commit (@-): kyzluvzy 863c6e7b test(music): verify packed daemon under Node
```

## Residual risks

The machine-local smoke still depends on Bun, npm, tmux, and availability of the exact pinned OpenCode package. A tmux connection/inspection failure is intentionally treated as unconfirmed termination: the smoke fails and retains/reports its unique root rather than risking deletion beneath a live host. Existing unrelated `.apnea` changes, including `.apnea/state.json`, were preserved and not edited.
