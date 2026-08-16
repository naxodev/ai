---
status: done
---

# Phase 3 package — certify the packed Pi extension with its exact pin

## Intent

Change only the existing Pi package smoke so it installs and executes the exact Pi versions selected by `packages/pi-music-dock/package.json`. The smoke must use the isolated install's `pi` executable, not `Bun.which("pi")` or whatever global version happens to be on `PATH`.

Keep the existing RPC-mode scope: load the packed extension, request `get_commands`, prove `/music`, `/music-next`, and `/music-prev` were registered by the extension, then close stdin and require prompt process exit. This phase does not exercise Pi's interactive status rendering, start a music-session client/daemon, alter peer support, or change product code.

## Exact steps

### 1. Preserve the approved baseline and derive policy from the manifest

1. Run `jj status` before editing.
2. Preserve approved Phase 2 commit `6613d6d1`, approved packed-core Phase 1, every earlier verified commit, unrelated worktree changes, `.apnea/state.json`, and `docs/music-session-architecture.html`.
3. Read all four Pi version values from `packages/pi-music-dock/package.json` rather than duplicating them as independent smoke constants:
   - exact `devDependencies["@earendil-works/pi-coding-agent"]`, currently `0.84.0`;
   - exact `devDependencies["@earendil-works/pi-tui"]`, currently `0.84.0`;
   - the corresponding declared peer ranges, currently `>=0.83.0 <0.85.0`.
4. Reject a missing/non-exact tested pin and require each tested pin to satisfy its corresponding peer range before installing.
5. Do not change either exact tested pin, either peer range, package metadata, or `bun.lock`.
6. Work through the configured Pi role profile in a regular pane. Do not commit or squash; the orchestrator performs `jj squash` only after phase approval.

### 2. Put every smoke-owned archive and install under one temporary root

In `packages/pi-music-dock/scripts/package-smoke.ts`:

1. Create the unique temporary root before packing any smoke-owned package.
2. When the smoke creates the Pi extension archive itself, run `npm pack --pack-destination <root>` so no tarball is written to `packages/pi-music-dock`.
3. Pack `@naxodev/music-core` into the same temporary root.
4. If the existing optional archive argument is retained, treat that caller-supplied archive as external and do not delete it; all archives created by this smoke remain owned by the root.
5. Keep the generated install manifest, lockfile, isolated Pi config/session directories, captured diagnostics, and all other generated content under the temporary root.
6. Begin failure-safe ownership as soon as the root exists so pack, install, spawn, RPC, assertion, and cleanup errors cannot leave a repository tarball or unreported temporary install.

Do not add a checked-in fixture, lockfile, helper, or second smoke script.

### 3. Install packed extension/core plus the exact Pi packages

Write the temporary project's `package.json` with these explicit dependencies:

- packed `@naxodev/pi-music-dock`;
- packed `@naxodev/music-core`;
- `@earendil-works/pi-coding-agent` at the exact tested development pin;
- `@earendil-works/pi-tui` at the exact tested development pin.

Retain the existing override that forces the packed music core. Then:

1. Install inside the temporary root with lifecycle scripts disabled; Pi's documented normal npm package does not require install scripts.
2. Read the installed manifests for both Pi packages and require their versions to equal their respective exact pins, not merely satisfy the peer ranges.
3. Recheck that each installed exact version satisfies the packed extension's declared peer range.
4. Read the installed music-dock manifest and retain the existing checks for package name and `pi.extensions: ["./extensions"]`.
5. Realpath the installed music-dock and music-core roots and require both to be beneath the temporary project's `node_modules` tree and outside the repository's `packages/pi-music-dock` and `packages/music-core` source directories.
6. Do not rely on workspace linking, a global Pi install, or package-manager peer auto-selection as evidence of the exact version.

### 4. Resolve and prove the exact installed `pi` executable

1. Resolve the temporary project's `node_modules/.bin/pi` and realpath it.
2. Read `bin.pi` from the installed `@earendil-works/pi-coding-agent` manifest, resolve that manifest-selected target, and require it to equal the `.bin/pi` realpath.
3. Require the realpath to remain beneath the temporary install's `node_modules/@earendil-works/pi-coding-agent` directory.
4. Invoke that absolute executable with `--version` and require exact output `0.84.0` (the manifest-derived pin).
5. Remove the current `Bun.which("pi")` lookup. Do not use `/usr/bin/env` or a global/PATH executable fallback.
6. Print the exact installed version and resolved executable path in successful smoke output.

A machine with global Pi `0.84.2`, another supported version, or no global Pi at all must still run the smoke against the isolated `0.84.0` executable.

### 5. Run only the packed extension's RPC registration smoke

Spawn the absolute executable from Step 4 as one directly owned process/process group. Retain the existing flags that isolate resource discovery:

```text
--mode rpc
--no-session
--no-extensions
--no-skills
--no-prompt-templates
--no-themes
--no-context-files
-e <isolated-installed-package-directory>
```

Also isolate Pi's runtime from user settings/network behavior:

1. Set `PI_CODING_AGENT_DIR` to a directory beneath the temporary root.
2. Set `PI_OFFLINE=1` so update checks, package checks, and telemetry cannot affect the smoke.
3. Keep `cwd` beneath the temporary root and pass the installed package directory to the explicit `-e` flag. Per Pi's CLI contract, `--no-extensions` disables discovery while `-e` loads exactly the requested package.
4. Do not start an interactive TUI or use a model/API credential.

Use Pi RPC's strict LF-delimited JSON framing:

1. Write exactly one correlated `{"type":"get_commands","id":"smoke"}` record followed by `\n`, then close stdin.
2. Drain stdout and stderr immediately so a verbose failure cannot block the child.
3. Await exit under an explicit bound. EOF must cause status-zero process exit; a timeout is a smoke failure.
4. Parse stdout records by LF only, stripping an optional trailing `\r`; do not use Node `readline` or split on Unicode separators.
5. Select the response with ID `smoke`, require a successful `get_commands` response, and filter commands whose source is `extension`.
6. Require extension commands named `music`, `music-next`, and `music-prev`.

The extension intentionally starts its music-session client only for `ctx.mode === "tui"`; RPC mode proves package loading/registration without starting a daemon/provider. Do not change that product behavior or invoke transport commands in this phase.

### 6. Bound exact process teardown before deleting files

1. Track the exact Pi child/process group immediately after spawn.
2. On normal completion, require status zero and confirm the exact process group has exited before removing its installed files.
3. On timeout or assertion failure while the child remains live, send `SIGTERM` only to that exact process group, await it under a bound, then use `SIGKILL` only for the same exact group if necessary.
4. Confirm process-group termination after signaling. Never use `pkill`, `killall`, or a broad process-name match.
5. Remove the unique temporary root only after termination is confirmed. This cleans smoke-owned archives, packed packages, exact Pi packages, generated lock/config/session content, and captured files together.
6. If termination cannot be confirmed, fail, retain the unique temporary root, and report its path rather than deleting beneath a possibly live Pi process.
7. Preserve the original failure and append cleanup diagnostics if teardown also fails.

A successful run must leave no Pi child, daemon/provider handle, tarball, socket, marker, bind reservation, log, temporary install, or generated package content. Because RPC mode does not start the music client, a daemon/provider appearance is a failure rather than something to clean with a broad process command.

### 7. Run only the phase verification

Run the commands below. Report the manifest-derived exact versions, installed Pi executable, isolated packed package roots, three registered commands, bounded status-zero exit, and cleanup success.

Do not run OpenCode, documentation, full-workspace, or mixed-host gates in this phase.

## Files to touch

- `packages/pi-music-dock/scripts/package-smoke.ts`

## Files not to touch

- `packages/pi-music-dock/package.json`
- `packages/pi-music-dock/project.json`
- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/extensions/music-dock/format.ts`
- `packages/pi-music-dock/extensions/music-dock/waveform.ts`
- `packages/pi-music-dock/test/**`
- `packages/opencode-music-player/**`
- `packages/music-core/**`
- `packages/pi-apnea/**`
- `README.md`
- `packages/pi-music-dock/README.md`
- `packages/music-core/README.md`
- `packages/opencode-music-player/README.md`
- `docs/music-session-architecture.html`
- `package.json`
- `bun.lock`
- `.apnea/state.json`
- Any unrelated dirty file or generated archive/install/config/lockfile

## Acceptance checks

- The smoke derives exact tested versions `0.84.0` for both Pi packages from the music-dock manifest and confirms they satisfy the unchanged peer ranges.
- Packed music dock, packed music core, exact `@earendil-works/pi-coding-agent`, and exact `@earendil-works/pi-tui` are installed in one isolated temporary project without workspace fallback.
- Installed Pi package manifests report exactly `0.84.0`; a merely compatible or package-manager-selected version is rejected.
- The executed `pi` is the manifest-matching realpath behind the isolated project's `node_modules/.bin/pi`, and `--version` reports exactly the manifest-selected pin. `Bun.which("pi")` and global/PATH binaries cannot pass.
- The packed manifest exposes `./extensions`, and exact Pi loads that installed package through explicit `-e` in RPC mode.
- The correlated successful `get_commands` response includes extension commands `/music`, `/music-next`, and `/music-prev`.
- Closing RPC stdin produces bounded status-zero host exit without starting or retaining a music-session client, daemon, provider, or timer.
- The exact process group is confirmed terminated before smoke-owned archives/install/runtime files are removed. An unconfirmed process group causes a reported retained root instead of unsafe deletion.
- Success leaves no owned process, tarball, socket, marker, bind reservation, log, temporary install, or generated repository content.

## Verify commands

Run from the repository root:

```sh
bunx nx run pi-music-dock:smoke --skip-nx-cache
! find packages/pi-music-dock -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
jj diff --summary
jj status
```

Successful smoke output must identify exact installed Pi `0.84.0` and its isolated executable path, identify isolated packed music-dock/core roots, report all three extension commands, and report status-zero exit/cleanup success. It must not depend on or report the global Pi executable as the selected host.

## Dependencies

- Approved exact-pinned OpenCode Phase 2 at `6613d6d1` and packed-core Phase 1 at `863c6e7b`.
- Existing `pi-music-dock:smoke` target and RPC registration smoke in `packages/pi-music-dock/scripts/package-smoke.ts`.
- Exact tested Pi package pins and compatible peer ranges in `packages/pi-music-dock/package.json`.
- Pi's documented package manifest, explicit `-e` loading, RPC `get_commands`, strict JSONL framing, and `PI_OFFLINE`/`PI_CODING_AGENT_DIR` isolation behavior.
- Bun/npm and Node satisfying the package engine on macOS.

## Non-goals

- Updating exact Pi pins, widening/narrowing peer ranges, testing every supported peer version, or changing package dependencies/metadata.
- Interactive Pi TUI/status/waveform rendering, shortcuts, command execution, transport behavior, reload, live provider success, or artwork.
- Starting or changing the music-session daemon/client, Effect v4 ownership, protocol, idle exit, or cleanup implementation.
- OpenCode changes, core changes, documentation, full repository checks, mixed-host verification, or PR-description work.
- New tests/helpers, checked-in fixtures, commits, squashes, pushes, publication, PR creation, `.apnea/state.json` edits, or cleanup of unrelated worktree changes.
