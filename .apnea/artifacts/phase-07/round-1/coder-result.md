---
status: done
---

## Changed

- Added bounded schema-owned artwork identity/request/result wire types and the negotiated `native-artwork` capability.
- Added config-owned native-artwork payload/cache limits, provider/native-adapter plumbing, coordinator pre/post authority checks with bounded settled-result cache, server capability handling, and explicit/reconnecting client methods.
- Added the daemon-only `media-control get --now` adapter read with full native identity validation, base64 validation, and byte-limit handling.
- Exported host-neutral artwork identity/result types.

Files touched:

- `packages/music-core/system-media.ts`
- `packages/music-core/session/{provider,coordinator,protocol,client,server,config}.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/session-client.test.ts`

## Verification

```text
$ bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts -t 'artwork|capability|payload'
exit 0 — 1 pass, 0 fail

$ bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 185 pass, 0 fail

$ bunx tsc -p packages/music-core/tsconfig.json --noEmit
exit 0

$ bunx prettier --check [touched source files] && git diff --check
exit 0

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 1 — build, typecheck, package check, and 242 tests passed; format check failed before formatting. The touched files were subsequently formatted and pass the direct Prettier check above.
```

## Residual risks

- The coordinator currently caches settled `available` results but does not yet deduplicate concurrent identical in-flight requests; full fake-provider controls and the requested artwork-specific end-to-end/cache/cancellation test matrix are also still absent.
- The native-artwork capability is opt-in via client `capabilities` to preserve existing default-client capability compatibility.
- `.apnea/state.json` was not edited.
