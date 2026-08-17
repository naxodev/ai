---
status: done
---

# Phase 1 rework result

## Amendments

- `packages/music-core/session/config.ts`
  - Replaced the metadata-only pre-hello marker snapshot with a validated live marker-generation proof: secure artifact identity, parsed UID/PID/token, liveness, and a post-read identity check.
  - `starting()` now requires the exact same fresh marker generation after the hello reset. In-place marker rewrites (same inode) and artifact replacement fail closed.
- `packages/music-core/tests/session-client.test.ts`
  - Added deterministic same-inode marker-token rewrite coverage; it remains `occupied`, retains both artifacts, and exposes no cleanup capability.
  - Replaced the fabricated coordinator exit result with a managed launcher seam that emits split `music-sessiond:` stderr and an actual pre-readiness child `exit`; acquisition receives the bounded typed `exit` error.
- `packages/music-core/session/client.ts`
  - No additional rework change; the existing launcher/coordinator wiring is exercised by the new end-to-end seam test.

## Verification

All commands ran from the repository root.

```text
$ bun test packages/music-core/tests/session-client.test.ts
exit 0
79 pass, 0 fail, 434 expect() calls

$ bunx nx run music-core:typecheck --skip-nx-cache
exit 0
Successfully ran target typecheck for project music-core

$ bunx nx run music-core:format:check --skip-nx-cache
exit 0
All matched files use Prettier code style!

$ bunx nx run music-core:test --skip-nx-cache
exit 0
271 pass, 0 fail, 1227 expect() calls

$ bunx nx run music-core:package:check --skip-nx-cache
exit 0
Bundled 201 modules in 51ms
Verified npm package contents (21 files)

$ bunx nx run music-core:smoke --skip-nx-cache
exit 0
negotiated daemon: music-session-clp5vmruhnh revision 1
status-zero idle exit and cleanup: ok

$ bunx nx run opencode-music-player:smoke --skip-nx-cache
exit 0
installed OpenCode 0.0.0-next-17386
OpenCode loaded the installed package and rendered its app and sidebar slots.
OpenCode package smoke cleanup: ok

$ bunx nx run pi-music-dock:smoke --skip-nx-cache
exit 0
installed Pi 0.84.0
Pi registered extension commands: /music, /music-next, /music-prev
Pi RPC status-zero exit and cleanup: ok

$ ! rg -n '\[DEBUG-[^]]+\]' packages/music-core packages/opencode-music-player packages/pi-music-dock; git diff --check; test -z "$(find packages -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit)"
exit 0
```

The first full `music-core:test` invocation hit the pre-existing concurrent-startup race (`20 concurrent managed callers...` reported occupied); its immediate no-edit rerun passed. Nx marked the task flaky. The focused suite and final full suite both passed.

## Live attachment evidence

Baseline and every successful before/during/after direct hello checkpoint preserved:

```text
PID:        45621
Generation: music-session-zqg8kksdwec
Socket:     16777231:1237478212:501:600
```

- Exact isolated OpenCode: set `TMPDIR` to its canonical path before running the prescribed install. This preserves the required containment check across macOS `/var` → `/private/var` aliasing without weakening it. The trusted install produced:
  - binary: `/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-next-17386.Rhpubz/node_modules/@opencode-ai/cli/bin/opencode2.exe`
  - version: `opencode2 v0.0.0-next-17386`
  - checkout plugin: `/Users/nachovazquez/work/1-projects/naxodev/ai/packages/opencode-music-player`
  - UI: rendered the checkout player slot with no `1 plugin failed` or startup error. No playback control was issued. OpenCode exited normally; its ownership-checked root was removed and the post-exit checkpoint passed.
- Exact isolated Pi: `0.84.0`, profile `/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/pi-attachment.wH9Ssr`, checkout extension `/Users/nachovazquez/work/1-projects/naxodev/ai/packages/pi-music-dock`. The rendered UI listed `music-dock`, showed the current empty/paused dock state, and contained no unclassifiable-peer or extension startup error. No playback control or reload was issued. Pi exited with the normal double-Ctrl-C path, its ownership-checked root was removed, and the post-exit checkpoint passed.

Neither host signaled, replaced, unlinked, cleaned, or otherwise took ownership of the unrelated production daemon or its clients.

## Residual risk

No product-scope blocker remains. The existing 20-client startup test is timing-sensitive under this local Bun run (one initial full-suite failure, immediate rerun green); it is retained unchanged and Nx reported it as flaky. No commit, push, or `.apnea/state.json` edit was made.
