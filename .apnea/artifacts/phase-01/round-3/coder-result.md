---
status: done
---

# Phase 1 rework result

## Amendment

- `packages/music-core/session/client.ts`: diagnostic conversion now trims the retained byte buffer to a prefix whose UTF-8 re-encoding is at most 512 bytes. This prevents a partial trailing multibyte code point from expanding to U+FFFD and violating the host-visible byte bound.
- `packages/music-core/tests/session-client.test.ts`: added a deterministic boundary case with an emoji split at byte 512; it verifies daemon prefix retention, valid decoded output (no U+FFFD), and an encoded length no greater than 512 bytes.
- `packages/music-core/session/config.ts`: unchanged in this rework.

## Verification

```text
$ bun test packages/music-core/tests/session-client.test.ts
exit 0
80 pass, 0 fail, 437 expect() calls

$ bunx nx run music-core:typecheck --skip-nx-cache
exit 0
Successfully ran target typecheck for project music-core

$ bunx nx run music-core:format:check --skip-nx-cache
exit 0
All matched files use Prettier code style!

$ bunx nx run music-core:test --skip-nx-cache
exit 0
272 pass, 0 fail, 1230 expect() calls

$ bunx nx run music-core:package:check --skip-nx-cache
exit 0
Bundled 201 modules in 44ms
Verified npm package contents (21 files)

$ bunx nx run music-core:smoke --skip-nx-cache
exit 0
negotiated daemon: music-session-ynevfskkjcl revision 1
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

The prior round's successful attachment-only host evidence remains applicable: exact isolated OpenCode `0.0.0-next-17386` and Pi `0.84.0` attached to PID `45621` with generation `music-session-zqg8kksdwec` and socket identity `16777231:1237478212:501:600`, then exited with their owned roots removed. This UTF-8-only rework does not interact with host acquisition, process ownership, or the daemon endpoint.

## Residual risk

None introduced by this narrow conversion-boundary fix. No commit, push, `.apnea/state.json` edit, or non-approved product-file edit was made.
