---
status: done
---

Implemented independent artwork presentation for the OpenCode system-media facade and controller.

Files touched:

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/types.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`

The facade now projects playback synchronously, runs keyed artwork work detached, forwards typed core events, and publishes separately disposable artwork completion events. The controller merges only artwork presentation into a matching active recording. Tests cover unresolved artwork lanes, provider-ID changes, cache hits, rejection retries, disposal, and stale replacement events.

Verify transcript:

```text
$ bunx nx run-many -t typecheck test format:check --projects=opencode-music-player --skipNxCache
... tsc --noEmit
... bun test --preload @opentui/solid/preload
135 pass
0 fail
... prettier --check .
All matched files use Prettier code style!
NX Successfully ran targets typecheck, test, format:check for project opencode-music-player
exit: 0
```

Residual risks: none identified within the phase scope.
