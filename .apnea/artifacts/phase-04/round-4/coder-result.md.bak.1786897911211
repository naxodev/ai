---
status: done
---

## Changed

Addressed the remaining ownership and executable-boundary review findings:

- The wrong-mode artifact test now uses a real stale Unix socket chmodded to `0644`, proving typed rejection while device/inode/mode and socket type remain unchanged.
- Added a test-only daemon runtime seam; production still resolves its fixed per-UID `/tmp` layout.
- Replaced graph-stub executable coverage with a real config → fake-provider → coordinator → server graph for managed-default and explicit modes. It observes the bound `0600` socket, verifies managed `0700` directory preparation, verifies explicit mode does not create the managed directory, and confirms exactly-once provider finalization.
- Added an actual unsafe managed-directory (`0755`) executable path test, confirming server/config propagation retains tagged operation/path/message diagnostics and sets nonzero status without repairing the directory.

Files touched:

- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
65 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
195 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- The runtime seam is test-only and not sourced from environment or CLI input.
- No startup coordination, spawning, retry, reconnect, or idle-shutdown behavior was added.
