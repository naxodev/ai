---
status: done
verdict: APPROVED
nits: |
  Replace remaining setTimeout(0) artwork flushes with deterministic sentinels, and add explicit adapter-backed loading assertions plus a provider-unavailable case when convenient.
---

## Package comparison

The Phase 8 package remains aligned with the approved plan. The cumulative diff is confined to allowed OpenCode source/test paths, retains the direct production selector, and does not move core, Pi, manifest, lockfile, docs, or presentation implementation ownership.

## Review

No blocking findings remain.

The final adapter now:

- owns one one-shot public reconnecting client with a distinct stable process-local ID;
- projects retained replay/live state and accepts lower-revision replacement generations;
- combines provider and connection lifecycle feedback with connection-error precedence and deduplicated retained replay;
- delegates controls once without adding provider, polling, sampling, clock, or command-queue ownership;
- routes native artwork only through `client.artwork` while retaining host-local fallback/resolution/presentation work;
- fences released native/resolver completion before fallback or cache mutation;
- removes abandoned/null retry ownership while preserving successful shared cache entries and unrelated owners;
- makes disposal inert, idempotent, exact-once, and safe before or after client acquisition;
- leaves `controllerDependencies.createBackend: createSystemMedia` unchanged for Phase 9.

The accumulated tests now cover factory failure and one-shot acquisition, replay/lifecycle precedence and late observers, all delegated controls, bounded artwork outcomes/fallback, observer isolation, retry/cache ownership across adapter generations, post-disposal inertness, active and late-client cleanup, adapter-backed A/reconnect/lower-revision-B/idle/terminal controller state, optimistic transport and seek coalescing, command failure/toast behavior, full-identity artwork merge fencing, held command/artwork/reconnect callbacks after disposal, queued-command suppression, and exact unsubscribe/release ordering.

## Verification

The package-cwd focused four-file suite passes 70 tests. The final Nx typecheck/test/format/package matrix passes with 259 music-core and 170 OpenCode tests. `git diff --check` and selector/native-command inspection are clean. The exact root preload command cannot resolve the workspace preload in this checkout; its package-cwd equivalent and the Nx project target both pass.
