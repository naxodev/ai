---
status: done
---

## Investigation

No production change was retained this round.

The unresolved singleton requirement cannot be satisfied by simply removing the reservation: a direct two-process Bun probe showed that two independent `net.Server.listen()` calls against the same missing Unix path both report `listening`. The existing sidecar is therefore compensating for a Bun runtime behavior, not merely an in-process test artifact.

The available repository-pinned Node/Bun APIs provide no process-death-released advisory file-lock primitive. An exclusive-create sidecar cannot atomically include a liveness payload: a crash between exclusive creation and the first durable payload write is inherently indistinguishable from a live writer. Reclaiming it is unsafe; preserving it wedges startup. The package needs an approved platform primitive/dependency or a revised runtime contract before a correct implementation can be retained.

The selected-graph shutdown experiment was also not retained: closing the coordinator scope before joining connection fibers caused established provider-disposal assertions to fail. The existing topology does not separate coordinator interruption from provider disposal.

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

Focused/full verification emitted the existing intentional injected unlink-failure warning; both commands exited successfully.

## Residual risks

- The current private bind-reservation sidecar retains an unrecoverable partial-write crash state.
- Selected listener-first shutdown still has the coordinator/connection wait cycle.
- Required daemon-process race, winner hello/non-interference, TestClock startup lifecycle, 20-way convergence, spawn-release, and skew-race coverage remains outstanding.
- No commit, push, or `.apnea/state.json` edit was performed.
