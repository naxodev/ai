---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 9 package is aligned with the approved cutover plan and the source diff removes the intended direct OpenCode ownership. All touched paths are allowed. However, the simplified controller can overwrite newer daemon state, and required production-cutover/artwork evidence was deleted rather than replaced.

## Findings

### High — A late command success can overwrite a newer authoritative daemon snapshot

`runCommand()` captures only `lifecycleGeneration`. Its success callback always applies optimistic play/pause/seek projection (`packages/opencode-music-player/index.tsx:126-159,163-188`). If a daemon snapshot arrives after the command is sent but before its Promise resolves, the snapshot updates the store, then the late success mutates that newer state. A late seek can replace authoritative progress; a late play/pause can replace authoritative playback state. This violates the package requirement that daemon live state remains authoritative.

Retain a narrow snapshot epoch (not the removed provider sampling machinery), capture it when issuing each optimistic command, and apply optimism only if no newer snapshot has been accepted. Add play/pause and seek tests that emit a conflicting snapshot while the command is held, then resolve the command and prove the snapshot wins.

### High — The rewritten artwork suite no longer proves required bounded cache/job behavior

The old tests for equal-key deduplication, bounded retry timing, settled eviction, and unresolved-job admission were removed. The replacement test named “bounds distinct jobs” exercises only three sequential non-available results; it never fills the 32-job capacity, proves no 33rd job is created, verifies recovery after a slot completes, or checks deterministic settled eviction. Rejected/disconnected artwork fallback and late full-identity session completion coverage were also removed from `system-media.test.ts`; the new `artwork-lifecycle` case is only a pure merge/ownership helper test, not an adapter/controller race.

Add deterministic session-adapter tests for equal-key sharing, 32 distinct blocked jobs plus excess admission/recovery, settled cache eviction/hit behavior, bounded null/rejection retries, and held A native/resolver completion after B becomes current. Prove the B controller/presentation remains authoritative.

### High — Capacity rejection can permanently strand the current track without artwork work

When `artworkJobs.size >= 32`, `artworkForTrack()` returns `{ loading: false }` without registering an interest, invoking catalog fallback, or arranging a bounded retry (`packages/opencode-music-player/system-media.ts:145-151`). Because production no longer polls `player()`, a current track whose one snapshot hits this branch receives no completion event and may never be projected again after capacity frees. The new test does not exercise this branch.

Provide a bounded recovery mechanism (or deterministic admission/eviction policy) that eventually runs fallback for the still-current identity without creating an unbounded waiting structure. Prove recovery after a pending slot completes and disposal removes any waiting interest.

### High — Package-load evidence does not exercise the production session adapter/client

The new “production backend” package-load test injects an arbitrary object via `createBackend`; it counts that object factory, not `createSessionSystemMedia` or its one reconnecting-client factory. It therefore does not prove that default plugin setup creates one session client shared by app/sidebar remounts, that fake daemon status drives feedback, or that cleanup disposes only that client once.

Inject `createSessionSystemMedia({ createClient: deterministicFake })` through the supported seam and mount/remount both slots. Assert one client factory call, shared store/replay, status feedback without local probes, and exact one-client disposal.

### High — Production controller coverage omits several required cutover races

The five rewritten controller tests cover replay/replacement, basic immediate commands, seek coalescing, one failure, terminal feedback, and disposal. They do not cover command attempts during reconnect/incompatibility, overlapping control failure/loading ownership, authoritative snapshot races, unavailable provider status, artwork loading/completion through the controller, or no seek replay across reconnect. The lifecycle suite also does not dispose during held artwork/reconnect work.

Restore focused deterministic cases for these Phase 9 requirements rather than relying on removed Phase 8 tests or generic helper tests.

## Verification

The focused package-cwd suite reports 19 passing tests and the Nx matrix reports 259 music-core plus 116 OpenCode tests with typecheck, format, and package checks green. Both forbidden-source scans and `git diff --check` pass: production now selects `createSessionSystemMedia` and contains no direct probe/stream/sample/poll/native command path. The verdict is based on the source race and missing cutover acceptance above.
