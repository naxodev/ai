---
status: done
---

# Phase 12 package — prove the packed core daemon/client under Node

## Intent

Add one isolated installed-package smoke for `@naxodev/music-core`. The smoke must build and pack the current core package, install that tarball and its declared dependencies outside the workspace, execute the installed client under Node, start the exact installed daemon selected from the packed manifest, complete hello/state replay, dispose the client, observe status-zero idle shutdown, and prove owned runtime cleanup.

This phase certifies core only. Do not exercise OpenCode or Pi, revise host package smokes, change session semantics, publish, or broaden into the final release gate.

## Implementation steps

### 1. Add a dedicated smoke mode to the existing core package verifier

Extend `packages/music-core/scripts/verify-pack.ts`; do not create a second verifier path.

1. Preserve its current default behavior for `music-core:package:check`: inspect `npm pack --dry-run --json --ignore-scripts`, assert the exact package file set, and validate the root export and `bin` mapping.
2. Add an explicit installed-smoke mode selected by one stable CLI flag. The mode must:
   - invoke the package's existing build command first;
   - create one unique temporary root with `mkdtemp` under the OS temporary directory;
   - run a real `npm pack` with scripts disabled and place the archive inside that temporary root, never in the repository;
   - create a separate temporary install project with a minimal `package.json` whose only application dependency is the produced `file:` tarball;
   - install with npm and scripts disabled so `effect@4.0.0-beta.101` and other declared runtime dependencies come from the packed manifest, not the workspace;
   - fail with captured, actionable stdout/stderr for build, pack, install, harness, or cleanup errors.
3. Resolve the installed package entry and installed package directory from the temporary project's Node module graph. Assert their real paths are beneath that temporary install and not beneath the repository's `packages/music-core` source directory.
4. Read the installed `package.json`, require `exports["."] === "./index.ts"`, read `bin["naxodev-music-sessiond"]`, and resolve the daemon from that relative manifest value. Reject a missing bin, a source-tree URL, `Bun.which`, `PATH` lookup, or a hard-coded `dist/music-sessiond.js` fallback.
5. Resolve an absolute Node executable before launching the harness and assert its version satisfies the package's declared Node floor. The lifecycle program itself must run under Node, not Bun; inside it, `process.execPath` must therefore be Node.

Keep all generated harness/package content inside the temporary root. Do not add a checked-in fixture, lockfile, tarball, or another script file.

### 2. Run the lifecycle entirely from the installed package

Have the verifier write a small `.mjs` harness into the temporary install project and launch it with the resolved Node executable.

The harness must import the public client/config API by package name (`@naxodev/music-core`), never by a workspace path or `file://` source URL. It should:

1. Reconfirm with `import.meta.resolve`/realpath that the imported root entry belongs to the installed package.
2. Create a unique managed runtime beneath the verifier's temporary root using installed `resolveMusicSessionRuntimePaths`, so it cannot collide with a developer's production `/tmp/naxodev-music-<uid>` daemon.
3. Create one installed `createReconnectingMusicSessionClient` with:
   - a test client ID and `hostKind: "test"`;
   - the installed runtime paths;
   - bounded startup attempts/delays suitable for a process smoke;
   - a launcher that spawns `process.execPath` with the manifest-selected installed daemon, the managed socket, and the smoke-only short idle-grace CLI option.
4. Before the successful lifecycle, invoke the installed manifest-selected daemon once under Node with an invalid `--idle-grace-ms` value and its own temporary socket. Require status `1`, an actionable idle-grace/config diagnostic, and no socket/runtime artifact; then release that exact child.
5. Use direct argv arrays, `shell: false`, and an explicit child environment. Give the successful daemon a deterministic PATH rooted in an empty temporary bin directory so it cannot select developer-installed `media-control`/`nowplaying-cli`; provider-unavailable state is valid for this lifecycle test. Do not fake or import server/provider layers.
6. Wait for the real client startup workflow to negotiate hello and replay. Assert:
   - a non-empty daemon instance ID;
   - a selected supported protocol revision and the requested baseline state/transport capabilities;
   - a replayed `RevisionedState` whose daemon instance matches the hello result;
   - a replayed provider status (an unavailable provider is acceptable and expected in the isolated PATH).
7. Dispose the reconnecting client and await its full supervisor/scope shutdown. Do not send a transport command merely to create activity; this phase is daemon/client lifecycle certification.
8. Await the exact spawned daemon process and require exit status `0` after the configured idle grace. Assert diagnostics include listening, idle shutdown, and stopped messages, and do not include playback or artwork payloads.
9. Assert the owned socket, startup marker, bind reservation, and bind-reservation temporaries are absent after daemon exit. The owner-only runtime directory may exist until the surrounding temporary root is removed.

The injected launcher is only a process-location boundary: startup discovery, lease acquisition/release, hello, replay, client disposal, server idle detection, daemon shutdown, and socket cleanup must all remain the installed production implementations.

### 3. Expose a short validated idle-grace option on the packaged daemon

The production daemon's default idle grace is intentionally too long for a package smoke. In `packages/music-core/session/music-sessiond.ts`, extend the existing CLI parser narrowly:

1. Support `--idle-grace-ms <positive-safe-integer>` alongside the existing `--socket <absolute-path>` option and include it in `--help` usage.
2. Put the parsed value into `MusicSessionOptions` and let the existing Effect config resolution validate it. Do not read environment variables directly, bypass `Config`, or duplicate the idle timer.
3. Preserve all current behavior when the option is absent, including the production default, managed runtime selection, selected graph, diagnostics, signal handling, error status, and shutdown order.
4. Reject missing, nonnumeric, fractional, zero, negative, or unsafe values through the existing daemon error/status boundary. The packed smoke may use a short but nonzero grace that still leaves enough time for hello to complete.

Do not add a new daemon mode, fake provider flag, test graph, alternate socket implementation, or child-kill policy.

### 4. Wire package and Nx commands without changing package contents

In `packages/music-core/package.json`:

1. Add a `smoke:package` script that invokes the installed-smoke mode of the existing verifier.
2. Keep `pack:check`, `prepack`, `build`, `files`, `exports`, `bin`, versions, engines, and dependencies unchanged. The verifier remains excluded from the packed tarball.

In `packages/music-core/project.json`:

1. Add a `smoke` target matching the workspace convention and run `bun run smoke:package` from `packages/music-core`.
2. Do not add the smoke to `package:check`; the two targets must remain independently runnable so the package allowlist check stays fast and deterministic.
3. Do not edit root workspace scripts. The root release gate already discovers Nx `smoke` targets later.

### 5. Make cleanup failure-safe

Both verifier and generated Node harness must use `try/finally` ownership:

1. Track the client, daemon child, harness child/process group, archive, install root, and runtime paths as soon as each is acquired.
2. On assertion, timeout, install, or startup failure, dispose the client if present, terminate only the exact spawned child/process group, await process exit, and then recursively remove the unique temporary root.
3. Bound startup and daemon-exit waits with explicit diagnostic timeouts. A timeout must fail the smoke rather than leave a detached process.
4. Never signal an existing daemon, delete the default production runtime, use broad `pkill`/`killall`, or unlink an artifact without exact ownership.
5. On success and failure, leave no repository tarball, temporary project, socket, marker, bind reservation, log, or live child process. The ignored build output `packages/music-core/dist/music-sessiond.js` is the expected result of the declared build and must not be added to version control.

## Files to touch

- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/session/music-sessiond.ts`

## Files not to touch

- `packages/music-core/session/client.ts`, `config.ts`, `server.ts`, `provider.ts`, `coordinator.ts`, `protocol.ts`, or `framing.ts`.
- `packages/music-core/index.ts`, package file allowlist, dependencies, versions, or `bun.lock`.
- Existing core unit/integration tests unless the CLI parser cannot be kept private; prefer the installed smoke as the end-to-end acceptance for the new option and do not widen session acceptance.
- `packages/opencode-music-player/**` and `packages/pi-music-dock/**`.
- Root `package.json`, other workspace projects, READMEs, changelogs, or `docs/**`, including `docs/music-session-architecture.html`.
- Phase 13/14 host smoke implementations, exact-host executable assertions, UI rendering, or command registration checks.
- Generated archives, checked-in harnesses, temporary installs, runtime files, ignored `dist/` output, unrelated dirty changes, and `.apnea/state.json`.

## Acceptance checks

- `music-core:package:check` retains its exact dry-pack allowlist behavior and does not run the installed lifecycle smoke.
- `music-core:smoke` builds core, creates a real tarball outside the repo, installs it plus declared runtime dependencies into a unique project, and resolves both public client code and daemon executable exclusively from that install.
- The lifecycle harness runs under a Node version allowed by the package manifest. No Bun runtime, workspace source import, hard-coded source path, PATH-selected daemon, or unpacked build fallback executes the client/daemon lifecycle.
- The daemon path comes from the packed manifest's `naxodev-music-sessiond` entry and is the installed `dist/music-sessiond.js`.
- The installed reconnecting client performs real managed discovery/startup-marker coordination, starts the installed Node daemon through the injected location boundary, negotiates hello, and receives status plus state replay from the same daemon instance.
- Client disposal is awaited, no command is replayed or fabricated, and the installed daemon exits with status zero through the real zero-client idle path.
- The installed daemon preserves default idle behavior unless the validated CLI option is present; invalid values fail through the existing executable error/status contract.
- Socket, marker, bind reservation, bind temporaries, child processes, archive, install project, and temporary root are cleaned on success and every failure path. No default production daemon/runtime is disturbed.
- Existing Effect v4 ownership, shutdown order, singleton/startup, reconnect, fan-out, artwork, package exports, and host behavior remain regression baselines only.

## Verification commands

Run from the repository root:

```sh
bunx nx run music-core:package:check --skip-nx-cache
bunx nx run music-core:smoke --skip-nx-cache
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core --skip-nx-cache
! find packages/music-core -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
git diff --check
jj diff --summary
jj status
```

The smoke command must report the installed package root, manifest-selected daemon path, negotiated daemon instance/revision, status-zero idle exit, and cleanup success without printing playback/artwork payloads or retaining its temporary paths.

Do not run OpenCode or Pi smoke targets in this phase.

## Dependencies

- Phase 5's zero-client idle shutdown and exact-owned runtime cleanup.
- Phase 3's managed discovery/startup-marker workflow and Phase 4's reconnecting client disposal semantics.
- Phase 11's approved package root export, exact file allowlist, `bin` mapping, publishable metadata, and retained `createSystemMedia()` compatibility API at `31f1c2d4`.
- Existing detached-launch unit coverage; this smoke supplies the installed Node process evidence without changing the production client launcher.
- Repository-pinned Bun `1.3.7` for orchestration/building, package-declared Node `>=22.19.0` for the installed lifecycle, npm for isolated install, and Effect TypeScript `4.0.0-beta.101` from the tarball manifest.

## Non-goals

- OpenCode/Pi package installation, rendering, command registration, exact host version checks, or host process-exit certification.
- Provider/media-tool success, playback transport, native artwork, catalog lookup, or UI behavior; provider-unavailable replay is sufficient.
- Changing daemon/client protocol, startup policy, reconnect policy, idle ownership/default duration, socket security, provider graph, shutdown ordering, diagnostics payload policy, or process launcher semantics.
- Adding a new verifier file, checked-in fixture, deep package export, dependency, package version, lockfile change, publication, or documentation.
- Running the full workspace release gate, committing, squashing, pushing, opening a PR, or editing `.apnea/state.json`; the orchestrator performs the reviewed-child `jj squash` only after approval.
