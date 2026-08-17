---
status: done
---

# Phase 1 implementation result

## What changed

Reviewed and retained the existing narrow child corrections; no additional product edit was necessary.

- `packages/opencode-music-player/scripts/package-smoke.ts`: synchronous diagnostic rendering preserves available output and treats absent `stdout`/`stderr` as empty strings.
- `packages/pi-music-dock/scripts/package-smoke.ts`: applies the same safe diagnostic fallback and validates all piped RPC streams inside the lifecycle failure boundary, so failure cleanup terminates the exact detached process group before capturing available output.

The OpenCode pin, isolated packed-resolution checks, slot/layout assertions, and exact tmux cleanup remain intact. The Pi `0.84.0` pin, packed/peer isolation, extension registrations, status-zero response validation, process-group lifecycle, installed-core check, and confirmed cleanup remain intact.

## Files touched

No product files were edited during this dispatch. The reviewed product slice relative to `@-` contains exactly:

- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/pi-music-dock/scripts/package-smoke.ts`

This result artifact is the only file written by this dispatch.

## Verification transcript

```text
$ jj log -r @- --no-graph -T 'commit_id' | grep -q '^b30f9987'
exit: 0

$ actual="$(jj diff --from @- --summary | awk '$2 !~ /^\.apnea\// { print $2 }' | sort)"; expected="$(printf '%s\n' packages/opencode-music-player/scripts/package-smoke.ts packages/pi-music-dock/scripts/package-smoke.ts | sort)"; test "$actual" = "$expected"
exit: 0

$ bunx nx run opencode-music-player:smoke --skip-nx-cache
exit: 0
installed OpenCode 0.0.0-next-17386: .../node_modules/@opencode-ai/cli/bin/opencode2.exe
isolated packed resolutions: plugin=.../node_modules/@naxodev/opencode-music-player/index.tsx; core=.../node_modules/@naxodev/music-core/index.ts
OpenCode loaded the installed package and rendered its app and sidebar slots.
OpenCode package smoke cleanup: ok
NX Successfully ran target smoke for project opencode-music-player
Cache: Skipped (--skip-nx-cache)

$ bunx nx run pi-music-dock:smoke --skip-nx-cache
exit: 0
installed Pi 0.84.0: .../node_modules/@earendil-works/pi-coding-agent/dist/cli.js
isolated packed roots: music-dock=.../node_modules/@naxodev/pi-music-dock; music-core=.../node_modules/@naxodev/music-core
Pi registered extension commands: /music, /music-next, /music-prev
Pi RPC status-zero exit and cleanup: ok
NX Successfully ran target smoke for project pi-music-dock
Cache: Skipped (--skip-nx-cache)

$ bun run check
exit: 0
NX Successfully ran targets typecheck, test, parity, format:check, package:check, smoke for 6 projects
Nx read the output from the cache instead of running the command for 30 out of 31 tasks.
Run duration: 914ms
Cache: 30/31 hit (97%)

$ git diff --check
exit: 0

$ test -z "$(find packages -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit)"
exit: 0

$ jj diff --from @- --summary | awk '$2 !~ /^\.apnea\// { print $2 }' | sort
exit: 0
packages/opencode-music-player/scripts/package-smoke.ts
packages/pi-music-dock/scripts/package-smoke.ts
```

## Residual risks

None identified within the Phase 1 scope. The full check intentionally used the repository's configured Nx cache; the two affected package smokes were run sequentially with `--skip-nx-cache`.
