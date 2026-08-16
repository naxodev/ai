---
status: done
---

# Phase 4 package: secure same-user runtime paths and endpoint discovery

## Intent

Add a secure default runtime location and conservative endpoint discovery without starting a process.

This phase must distinguish a missing endpoint, a proven stale owned endpoint, a healthy compatible daemon, a healthy incompatible daemon generation, an in-progress owned startup marker, and an unsafe/unknown artifact. Only an opaque proof produced for a stale same-user artifact may authorize removal. A successful protocol hello—not mere connect success—defines a healthy endpoint.

Preserve the approved explicit client, negotiated protocol, provider/coordinator authority, and scoped server/process lifecycle. Keep explicit custom socket paths working for focused foreground tests. Preserve unrelated worktree changes and `docs/music-session-architecture.html`. Use only repository-pinned Effect v4 APIs.

## Files to touch

Only as required:

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

## Files not to touch

- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- Anything under `packages/opencode-music-player/`
- Anything under `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

Do not create another source or test module. Keep runtime-path and artifact policy in `config.ts`, discovery in `client.ts`, and focused evidence in the existing client/server test files.

## Security and classification invariants

Implement these invariants consistently:

1. **Production default paths:** use the compact same-user layout `/tmp/naxodev-music-<numeric-uid>/s.sock` with startup marker `start.lock` in the same directory. Production does not take a runtime-root override from environment input.
2. **macOS path bound:** validate the UTF-8 byte length of the full socket path against the macOS Unix-domain path limit, leaving room for the terminating byte. Fail configuration before filesystem or socket work if it is too long.
3. **Managed directory:** it must be a real directory discovered with `lstat`, owned by the current numeric UID, and have no group/other permission bits (`0700`). Never follow a symlink with `stat`/`realpath` to make it acceptable.
4. **Managed socket:** it must be a real Unix socket, not a symlink, owned by the current UID, and contained directly in the verified managed directory. The daemon sets owner-only socket permissions (`0600`) after bind.
5. **Managed marker:** if present, it must be a non-symlink regular file owned by the current UID with owner-only permissions (`0600`) and schema-valid bounded JSON identifying marker version, UID, PID, and a non-empty attempt token.
6. **Conservative process check:** marker PID `ESRCH` can prove a stale marker; a live PID, `EPERM`, unknown error, malformed marker, or PID reuse uncertainty cannot authorize removal.
7. **Hello defines health:** a completed supported hello is healthy-compatible. A completed `INCOMPATIBLE_PROTOCOL` hello is a healthy-incompatible generation. Neither may be unlinked, killed, replaced, or relabeled stale.
8. **Stale socket proof:** only a connection refusal/no-listener result against a pre-inspected socket, followed by re-`lstat` of the same owner/type/device/inode inside the still-secure directory, may produce stale cleanup authority. A connect/hello reset, malformed peer, permission error, timeout policy, or unknown Node error is not stale.
9. **Revalidation before removal:** stale cleanup rechecks directory security and exact artifact identity immediately before `unlink`. `ENOENT` is harmless. Any replacement, symlink, type, owner, mode, device, or inode change aborts without removing the new artifact.
10. **Explicit paths remain explicit:** a caller-supplied absolute socket path remains the existing unmanaged foreground/test mode. It is never subject to automatic managed-runtime stale cleanup. The server may unlink only the exact socket it successfully bound there.
11. **No process lifecycle yet:** discovery performs one inspection/connect/hello classification pass. It does not spawn, wait/retry, detach, signal, or replace anything.

The managed directory's `0700` boundary prevents other users from racing child names after verification; still perform identity checks to avoid deleting same-user replacements or unrelated files.

## Exact implementation steps

### 1. Define runtime paths and typed boundary failures

In `packages/music-core/session/config.ts`:

1. Add a `MusicSessionRuntimeError` using `Schema.TaggedErrorClass` with stable `operation`, `path`, `message`, and optional defect cause. Use operations such as `resolve`, `prepare`, `inspect`, `probe`, and `remove` consistently.
2. Define the runtime-path record containing exactly:
   - managed directory;
   - socket path;
   - startup-marker path;
   - current numeric UID.
3. Implement a pure production resolver using `/tmp` and `process.getuid()`. Reject unavailable/invalid UID and overlong socket paths with `MusicSessionRuntimeError`; do not fall back to username, home directory, current directory, or an untrusted environment root.
4. Keep one narrow test dependency seam for alternate temporary root/UID and filesystem/process observation. Production defaults must use real `node:fs/promises`, real `process.getuid`, and real process existence checks.
5. Make `MusicSessionOptions.socketPath` optional. Resolve an absent path to the managed default. Retain an explicitly supplied absolute path as unmanaged; reject a relative path.
6. Extend resolved config with enough information for the server to distinguish managed default ownership from explicit foreground paths. Do not make tests infer this from string prefixes.
7. Make `layerFromConfig` use the managed default when `MUSIC_SESSION_SOCKET` is absent. A supplied environment socket remains an explicit absolute override. Continue routing malformed settings through `MusicSessionConfigError`.
8. Preserve all existing numeric defaults and config validation.

### 2. Prepare and validate the managed directory

In `packages/music-core/session/config.ts`:

1. Implement an Effect-wrapped managed-directory acquisition helper:
   - attempt `mkdir` with mode `0700` when absent;
   - tolerate only `EEXIST` before inspection;
   - inspect with `lstat`;
   - require directory type, current UID, and no group/other bits;
   - reject rather than `chmod` an unsafe pre-existing directory.
2. Verify the parent is exactly the intended `/tmp` production root (or the injected test root), and the socket/marker are direct children of the verified directory.
3. Do not recursively remove or repair the directory. Do not accept a symlink because its target looks secure.
4. Make managed server configuration prepare/verify this directory before listener creation. Explicit foreground configuration must retain its existing behavior and must not attempt to change `/tmp` permissions.
5. Wrap Node failures once at this filesystem boundary, preserving useful operation/path/cause diagnostics and interruption.

### 3. Inspect artifacts and create unforgeable stale authority

In `packages/music-core/session/config.ts`:

1. Add schema validation for marker JSON with bounded fields. Reading/parsing unknown marker contents is an untrusted boundary; do not cast parsed JSON.
2. Inspect socket and marker with `lstat` only. Return typed internal observations such as missing, safe socket, safe live marker, safe dead marker, or unsafe artifact.
3. Capture identity proofs with device/inode plus expected type, owner, path, and relevant mode. Keep proof constructors file-local or branded so arbitrary callers cannot request unlink by constructing a plain object.
4. Implement cleanup only through a stale-result closure or opaque proof produced by inspection/probing. Do not export a generic “remove runtime path” function.
5. Before each unlink, revalidate the managed directory and exact proof identity. If socket/marker disappeared, treat it as already clean; if it changed, fail safely and leave it untouched.
6. Remove only the proven stale socket and/or marker. Never remove the runtime directory, a healthy endpoint, an unverified marker, or any neighboring file.
7. If multiple stale artifacts are proven, attempt dependency-safe cleanup without turning an unsafe replacement into success. Preserve typed failure information.

Phase 5 will create the marker exclusively. Phase 4 only establishes its validated format, observation, and conservative stale-removal rule.

### 4. Add one conservative discovery API

In `packages/music-core/session/client.ts`:

1. Keep `createMusicSessionClient` as the explicit socket adapter from Phase 3. Add a separate discovery/probe entry point in this module for the managed default; do not export it from `index.ts` yet.
2. Define a discriminated result with enough information for Phase 5, covering:
   - `healthy`: owns a fully handshaken `MusicSessionClient`;
   - `incompatible`: contains the structured `MusicSessionClientError` from a completed hello and no cleanup capability;
   - `missing`: no socket and no live/stale marker needing action;
   - `stale`: contains only a guarded/idempotent cleanup operation backed by captured proof;
   - `starting`: a valid same-user marker whose process is conservatively live/unknown, with no cleanup capability;
   - `occupied` or equivalent conservative result: a listener/peer exists but did not complete a classifiable hello, with no cleanup capability.
3. Resolve and inspect the managed runtime before connecting. Unsafe directory/socket/marker observations fail as `MusicSessionRuntimeError`; they are not downgraded to missing/stale.
4. For a safe socket, make exactly one explicit connection/hello attempt using Phase 2 options and Phase 3 settlement behavior.
5. Classify only a completed `INCOMPATIBLE_PROTOCOL` response as `incompatible`. Preserve its client/daemon range details.
6. On successful hello, return `healthy` and transfer client ownership to the caller, who must dispose it.
7. Preserve Node connection error codes at the local `MusicSessionClientError` boundary (or a private connect result) instead of parsing message text. Use only the narrow no-listener codes supported by real tests to consider stale/missing.
8. For refusal/no-listener, re-inspect the same socket identity before returning `stale`. If the path disappeared, return `missing`; if identity changed or became unsafe, fail conservatively.
9. A successful TCP/Unix connect followed by malformed data, close, reset, schema failure, unsupported capability, or any non-incompatibility protocol error returns conservative occupied/unusable classification and no cleanup operation.
10. Consult a marker only after endpoint classification: healthy/incompatible always wins and leaves the marker untouched; no endpoint plus a validated dead marker may produce `stale`; no endpoint plus a live/unknown marker produces `starting`.
11. Ensure unsuccessful initial connection attempts remove exact temporary listeners and destroy their socket. Probe cleanup must not leak a raw socket.
12. Do not loop, retry, sleep, spawn, or call the executable.

### 5. Harden bound-path identity in the server

In `packages/music-core/session/server.ts`:

1. Preserve all approved connection scopes, closing refusal, foreground failure, and cleanup behavior.
2. For managed config, verify/prepare the runtime directory before creating/listening and reject unsafe pre-existing endpoint artifacts without unlinking them.
3. After successful bind, set socket mode `0600`, `lstat` it, verify current owner/socket type, and capture device/inode as this server scope's bound-path identity.
4. Mark ownership only after bind and identity capture both succeed. If post-bind hardening fails, close the partially acquired listener and remove only the socket proven to be that partial bind.
5. During finalization, compare the current path to the captured bound identity before unlinking. If it is gone, tolerate `ENOENT`; if it was replaced, report a typed unlink/security failure and leave the replacement untouched.
6. Apply exact bound-identity cleanup to explicit paths too, without imposing managed-directory mode policy on their parent.
7. A second daemon against an occupied managed path must fail and must not remove or chmod the first daemon's socket/directory.
8. Do not add stale probing/removal to the listener itself. Discovery owns stale classification; bind remains singleton authority in Phase 5.

### 6. Let the executable select the safe default without launching anything

In `packages/music-core/session/music-sessiond.ts`:

1. Make `--socket <absolute-path>` optional. With no flag, resolve the production managed default path; with the flag, retain explicit foreground behavior and absolute-path validation.
2. Update usage text accordingly while preserving `--help`/`-h` and the Phase 1 injectable runner.
3. Continue composing exactly one config → provider → coordinator → server graph and one top-level runtime boundary.
4. Keep diagnostics free of playback data. Runtime/path failures must retain tagged operation/path/message and set nonzero process status.
5. Do not add background launch, daemonization, startup marker creation, retries, or endpoint replacement.

### 7. Add focused filesystem/discovery tests

In `packages/music-core/tests/session-client.test.ts`:

1. Use temporary directories directly under `/tmp`, real files/symlinks/Unix sockets where possible, and a narrow injected UID/stat/process seam only for facts that cannot be created unprivileged (for example foreign ownership).
2. Keep every test failure-safe: dispose healthy clients, destroy raw sockets, close listeners/subprocesses, restore modes, release gates, and recursively remove only the test-created top-level temporary directory in `finally`.
3. Prove the path resolver yields the compact directory/socket/marker layout and keeps socket UTF-8 byte length below the macOS bound.
4. Prove a missing directory is created as `0700`, then accepted; pre-existing `0755`, symlinked, foreign-owned, and non-directory runtime paths are rejected without repair/removal.
5. Prove regular-file and symlink socket paths are rejected and retained. Simulate/observe foreign socket ownership and prove unlink is never called.
6. Start a real compatible server in a secure managed test directory. Probe it, assert `healthy`, complete hello, and dispose the returned client.
7. Probe the same live server with a disjoint revision range. Assert `incompatible` retains both ranges, exposes no stale cleanup, leaves directory/socket identity unchanged, and a supported client can still connect afterward.
8. Create a deterministic stale Unix socket using a short-lived child process that binds then exits without graceful unlink, or an equivalent real no-listener fixture. Assert refusal plus identity recheck produces `stale`; invoke cleanup twice and assert only the proven socket is removed.
9. Prove a valid dead marker can be cleaned only when no healthy endpoint exists. Prove live/unknown PID, malformed JSON, wrong mode, symlink, foreign owner, and non-regular marker cases are retained and never removed.
10. After obtaining stale proof, replace the artifact with a regular file or symlink before invoking cleanup. Assert identity revalidation refuses removal and preserves the replacement.
11. Prove malformed/reset peers classify conservatively with no cleanup capability.
12. Use Node events, subprocess exit, or Effect `Deferred`/`Queue`/`Latch`; do not use arbitrary sleeps, wall-clock age, `Date.now`, or polling loops.

### 8. Add focused managed-server tests

In `packages/music-core/tests/session-server.test.ts`:

1. Add compact tests for managed-path server acquisition only; do not reopen the lifecycle matrix.
2. Prove managed startup prepares/verifies `0700`, binds a real socket, sets `0600`, and captures ownership before reporting ready.
3. Prove shutdown removes only that exact bound socket and leaves the verified directory and unrelated neighboring file intact.
4. Replace the bound path after capture through a deterministic test gate if needed; assert cleanup does not unlink the replacement and reports a tagged operation/path failure while all other resources finalize.
5. Start a second server against the healthy managed endpoint and prove it neither chmods, closes, nor unlinks the first; the first remains connectable.
6. Preserve existing explicit random `/tmp/*.sock` tests unchanged as unmanaged foreground regression coverage.
7. Keep Phase 1/2/3 failure-safe cleanup patterns and deterministic synchronization.

### 9. Keep the phase narrow and tree green

1. Format only touched files.
2. Run client/server focused suites, then all `music-core` targets.
3. Inspect `jj diff --summary` and the exact diff. Preserve `.apnea/state.json`, `docs/music-session-architecture.html`, and unrelated paths.
4. Confirm no process launch entered production discovery in this phase.
5. Keep work in the current Jujutsu phase child for review. Do not run `git commit`, push, or `jj squash` during the coding round. After approval, use the run's prescribed `jj squash` step for only this reviewed phase.

## Acceptance checks

Phase 4 is done only when:

- The production default is a compact per-UID `/tmp` directory/socket under the macOS Unix-path bound; the directory is real, same-owner, and `0700`, and the bound socket is real, same-owner, and `0600`.
- Symlinked, foreign-owned, wrong-mode, and wrong-type managed directories, sockets, and markers fail closed and are never repaired, followed, connected through as trusted, or removed.
- Discovery performs a real negotiated hello before returning `healthy` or `incompatible`; a healthy incompatible daemon retains structured range details and is never unlinked, killed, replaced, retried, or disturbed.
- Only no-listener failure against the same revalidated socket identity, or a validated dead marker with no healthy endpoint, yields guarded stale cleanup authority.
- Stale cleanup is idempotent, revalidates directory/artifact identity, tolerates disappearance, and refuses to remove a replacement.
- Live/unknown markers and malformed/reset/unknown peers produce conservative no-cleanup classifications.
- The server unlinks only the exact socket identity it bound; occupied endpoints and replacements remain untouched while other scoped cleanup still completes.
- The executable can use the managed default or an explicit absolute socket but performs no startup coordination or spawning.
- Existing explicit client semantics, protocol negotiation, provider/coordinator authority, server lifecycle, and process-boundary suites remain green as regressions.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n "Bun\.spawn|child_process|spawn\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
jj diff --summary
```

The spawn scan applies to production source only; a focused test may launch a short-lived fixture process to leave a real stale Unix socket.

Inspect the diff after verification:

- changes are confined to the allowed Phase 4 paths;
- no protocol revision/schema, provider, coordinator, reconnect, idle, fan-out, artwork, host, manifest, package export, or documentation work entered the phase;
- managed cleanup has no generic path-based unlink entry point;
- explicit foreground tests and Phase 1–3 regressions remain green;
- `.apnea/state.json` and unrelated dirty paths remain untouched.

## Dependencies

- Approved explicit-client commit `1411d281`, negotiated-protocol commit `f059efc8`, process-boundary commit `e70641bc`, scoped-server commit `66bc1f91`, coordinator commit `859fc01d`, and provider commit `e7103663`.
- Existing structured `INCOMPATIBLE_PROTOCOL` details, `MusicSessionClientError.details`, explicit one-generation client, scoped server cleanup, and executable runner.
- Node/Bun `lstat`, `mkdir`, `chmod`, `readFile`, `unlink`, process UID/existence checks, and Unix-domain sockets on macOS.
- Repository-pinned Effect v4 `Effect`, `Config`, and `Schema.TaggedErrorClass` APIs.

## Non-goals

- Creating or exclusively acquiring the startup marker, detached daemon spawn, concurrent-launch arbitration, jittered wait, bind-loss handling, or provider acquisition race; Phase 5 owns singleton startup.
- Reconnect, replacement generations, retained presentation state, command replay policy changes, or zero-client idle shutdown.
- New protocol revisions/capabilities/messages, client request settlement changes, provider/coordinator behavior, server connection lifecycle changes, or another broad server audit.
- Per-client/global bounds, slow-reader handling, 24-client load, artwork, caching, OpenCode/Pi migration, or host presentation.
- Public index/manifests, packing, smokes, READMEs, architecture HTML, publishing, or versioning.
- New source/test modules, Git commits, squashing before approval, pushing, opening a PR, editing `.apnea/state.json`, or resetting/cleaning unrelated worktree content.
