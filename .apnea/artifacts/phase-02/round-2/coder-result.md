---
status: done
---

Updated `packages/opencode-music-player/tests/controller.test.ts` only.

The real-facade controller regression now keeps its initial fallback `player()` sample unresolved. It emits an authoritative stream snapshot and proves synchronous session projection with artwork loading. It then proves artwork completion decorates that session without another playback sample. Finally, it disposes the controller and resolves the fallback sample, proving stream cleanup and no late mutation, toast, or extra playback request.

Verify transcript:

```text
$ bunx nx run-many -t typecheck test format:check --projects=opencode-music-player
exit: 0
NX Successfully ran targets typecheck, test, format:check for project opencode-music-player
136 pass
0 fail
All matched files use Prettier code style!
```

Residual risks: none identified for this focused regression.
