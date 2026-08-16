---
status: done
---

## Changed

- Made `state-replay` optional during capability negotiation and explicit-client hello validation.
- Start the server state forwarder only for peers that negotiated `state-replay`; transport-only peers continue to receive hello/status and can submit transport commands.
- Extended the isolated oversized provider-state regression with a transport-only explicit healthy client. It connects before the oversized provider emission, receives no state replay, then completes `play()` through the real listener, bounded writer, and protocol response after the oversized target alone closes.
- Updated capability coverage for transport-only negotiation and the no-longer-impossible transport-only hello result.

## Files touched

- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-06/round-7/coder-result.md`

## Verification

```text
$ bun test packages/music-core/tests/session-server.test.ts -t 'oversized provider state'
exit 0 — 1 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t '24|slow reader|backpressure|overflow|oversized|capabilities'
exit 0 — 8 pass, 0 fail

$ bun test packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts -t 'capabilities|replay'
exit 0 — 8 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 135 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — 242 pass, 0 fail; build, typecheck, format, and package check passed

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

## Residual risks

- Transport-only peers deliberately do not receive automatic state replay; they can still request state explicitly and submit negotiated transport commands.
- No commit, push, or `.apnea/state.json` edit was performed.
