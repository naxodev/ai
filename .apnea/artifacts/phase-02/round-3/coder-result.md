---
status: done
---

Implemented the artwork cache rework.

Files touched:

- `packages/opencode-music-player/system-media.ts`: keep unresolved artwork entries in a separate job map; move them into the FIFO settled cache only after settlement. The settled cache remains bounded to 32 entries. Retry state and provider-ID-independent artwork keys remain unchanged.
- `packages/opencode-music-player/tests/system-media.test.ts`: add deterministic 33-recording coverage. It leaves the oldest job unresolved, applies eviction pressure from 32 settled entries, requests the oldest recording again, and verifies that the resolver still runs once.

Verify transcript:

```text
$ bunx nx run-many -t typecheck test format:check --projects=opencode-music-player
NX Successfully ran targets typecheck, test, format:check for project opencode-music-player
137 pass
0 fail
exit: 0
```

Residual risks: none identified. The in-flight job map is intentionally unbounded only for unresolved work and releases each entry on settlement.
