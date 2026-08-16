---
status: done
---

## Investigation

No additional production change was retained this round.

I attempted the required selected-topology shutdown reordering: stop listener/connection admission, interrupt connection fibers, close the coordinator scope, then await the fibers. Existing lifecycle tests showed this closes the selected scope before the provider finalizer is observed (`provider.counts.disposals` remained `0` in three established server lifecycle cases). The experiment was reverted to preserve the verified lifecycle baseline.

The remaining bind-reservation issue cannot be safely patched by treating an empty/partial exclusive-create file as stale: doing so creates a race that can delete the live contender's in-progress reservation. A correct repair requires either a process-death-released advisory lock primitive or a config/discovery-owned artifact protocol with an acquisition representation that is safe at every crash point. Neither is a small server-only patch.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
73 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
203 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "setTimeout\\(|setInterval\\(|Bun\\.sleep" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ git diff --check
exit 0
```

The focused run emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; it exited successfully.

## Residual risks

- Bind reservation policy remains private to `server.ts`; an interruption/crash before its PID payload is flushed can leave a conservative, unrecoverable reservation.
- Selected listener-first shutdown still has the blocked coordinator/connection wait cycle.
- The bind race has only same-process evidence; daemon-process hello and non-interference evidence is outstanding.
- TestClock startup pacing, 20-way convergence, spawn-failure release diagnostics, and terminal skew-race coverage remain outstanding.
- No commit, push, or `.apnea/state.json` edit was performed.
