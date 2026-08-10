---
status: done
---

# Coder Result

## Changes

- Added deterministic coverage for a live rejected Pi transport command.
- The test proves the existing error notification occurs once, its caller resolves, and the next queued command starts.
- No runtime change was needed. The existing transport queue already satisfies this regression.

## Files

- `packages/pi-music-dock/test/index.test.ts`
- `.apnea/artifacts/phase-04/round-1/coder-result.md`

## Verification

- Passed: `bun test test/index.test.ts` in `packages/pi-music-dock` with 13 tests passing.
- Passed: `PATH=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode/opencode-cli-next-17041/node_modules/.bin:$PATH bunx nx run-many -t typecheck test format:check package:check smoke --projects=pi-music-dock --skipNxCache`.
- Passed: `PATH=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode/opencode-cli-next-17041/node_modules/.bin:$PATH bunx nx run-many -t typecheck test format:check package:check -p music-core opencode-music-player pi-music-dock --skipNxCache`.
- Passed: `PATH=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode/opencode-cli-next-17041/node_modules/.bin:$PATH bunx nx run-many -t smoke -p opencode-music-player pi-music-dock --skipNxCache`.
- Pi smoke loaded the packed adapter and registered all music commands. OpenCode smoke loaded the installed package and rendered its app and sidebar slots.

## Residual Baseline Gate

- Blocked: root `PATH=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode/opencode-cli-next-17041/node_modules/.bin:$PATH bun run check` exits 1 at `Checking formatting...`.
- Root Prettier reports 13 pre-existing committed Apnea Markdown files outside Phase 4. They were not modified to satisfy this baseline gate.
