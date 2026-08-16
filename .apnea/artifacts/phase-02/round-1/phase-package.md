---
status: done
---

# Phase 2 package — certify the packed OpenCode plugin with its exact pin

## Intent

Change only the existing OpenCode package smoke so it installs and launches the exact OpenCode CLI version selected by `packages/opencode-music-player/package.json`. The smoke must not accept the developer's global `opencode2` merely because one happens to be on `PATH`.

Preserve the existing packed-plugin UI evidence: the real pinned OpenCode host loads the installed plugin and renders its deterministic session-backed playing, paused, collapsed, narrow, and smallest layouts. This phase does not change the plugin, UI, music-session behavior, package pin, or packed-core implementation.

## Exact steps

### 1. Preserve the approved baseline

1. Run `jj status` before editing.
2. Preserve approved Phase 1 commit `863c6e7b`, every earlier verified commit, all unrelated dirty changes, `.apnea/state.json`, and `docs/music-session-architecture.html`.
3. Read the exact OpenCode pin from `packages/opencode-music-player/package.json`: `dependencies["@opencode-ai/plugin"]` is currently `0.0.0-next-17386`.
4. Do not change that pin, add a range, or make the OpenCode CLI a published dependency of `@naxodev/opencode-music-player`.
5. Work through the configured Pi role profile in a regular pane. Do not commit or squash; the orchestrator performs the approved-phase `jj squash`.

### 2. Move all smoke-owned content under one temporary root

In `packages/opencode-music-player/scripts/package-smoke.ts`:

1. Create the unique temporary root before producing either archive.
2. Pack both `@naxodev/opencode-music-player` and `@naxodev/music-core` into that root using `npm pack --pack-destination`; do not create an archive in either package directory.
3. Keep the generated install manifest, lockfile, config, fixture rewrite, XDG directories, tmux resources, and captured diagnostics under that root or under the smoke's unique tmux socket.
4. Track the temporary root and exact tmux socket as soon as they are created so cleanup can run after pack, install, host-launch, render, or assertion failure.
5. Capture actionable stdout/stderr for pack and install failures instead of relying on inherited global state.

Do not add a checked-in fixture, lockfile, archive, config, or second smoke script.

### 3. Install the exact manifest-selected OpenCode CLI

Write the temporary project's `package.json` so its application dependencies include:

- the packed `@naxodev/opencode-music-player` archive;
- the packed `@naxodev/music-core` archive, with the existing override ensuring the plugin receives that packed core;
- `@opencode-ai/cli` at exactly the value read from `dependencies["@opencode-ai/plugin"]`.

Then:

1. Install all three into the temporary project with Bun.
2. Explicitly trust only the OpenCode CLI installation hook through Bun's temporary-project package policy, because that package installs/selects its platform executable. Do not add trust metadata to the repository package manifest.
3. Read the installed `@opencode-ai/cli` and `@opencode-ai/plugin` manifests and require both installed versions to equal the source manifest's exact pin.
4. Resolve the temporary project's `node_modules/.bin/opencode2` with `realpath` and require its target to remain beneath the temporary install's `node_modules` tree.
5. Invoke that absolute executable with `--version` and require the existing exact output contract, `opencode2 v0.0.0-next-17386`.
6. Remove the current startup check and launch behavior that call bare `opencode2`. Do not use `Bun.which`, `/usr/bin/env`, a shell `PATH` lookup, or a global fallback.

If the exact CLI package cannot install or its absolute binary/version does not match, fail with the pin, resolved path if any, and captured install/version diagnostics. Do not silently fall back to the global CLI.

### 4. Prove package-name resolution stays inside the isolated install

Before launching the TUI:

1. Generate any resolution probe inside the temporary project rather than checking in a test file.
2. Resolve and import `@naxodev/opencode-music-player` by package name from that project. Retain the existing assertion that the plugin has ID `music-player` and a callable `setup`.
3. Resolve `@naxodev/music-core` by package name from the same project.
4. Realpath both resolved entries and require them to be beneath the temporary project's `node_modules` tree and outside the repository's `packages/opencode-music-player` and `packages/music-core` source directories.
5. Keep the packed core override so the installed plugin cannot select the workspace core.

Do not import either package through a workspace path, source `file://` URL, or Bun workspace resolution fallback.

### 5. Launch the real exact-pinned host and preserve existing UI evidence

1. Keep the installed-entry fixture technique in the temporary install: retain the packed plugin's original entry and replace only the installed copy with the deterministic `createSessionMedia` fixture.
2. Preserve the existing fixture state, track markers, session creation/sync, and real host navigation. Do not move the fixture into source or add new presentation cases.
3. Build the tmux command with the absolute temporary `opencode2` path from Step 3. Shell-quote that absolute path and every argument; do not put bare `opencode2` in the command.
4. Preserve the isolated OpenCode config and XDG environment, disabled project configuration, disabled auto-update, and disabled model fetching.
5. Launch through the existing unique `tmux -L <socket>` server and retain the current assertions:
   - expanded playing state renders the real sidebar and compact slots without replacing adjacent host content;
   - a second launch renders paused state consistently;
   - sidebar collapse leaves exactly one compact row;
   - narrow width yields artist/title content correctly;
   - smallest width reduces to the playback marker.
6. Keep failures bounded and include a sanitized pane capture. Do not broaden this smoke into live-provider, daemon, playback-command, artwork, or new layout acceptance.

### 6. Make exact-resource cleanup failure-safe

In a top-level `try/finally` that begins after the unique root/socket are known:

1. Before removing the temporary root, terminate only the exact unique tmux server with `tmux -L <socket> kill-server`.
2. Confirm that exact tmux session/server is gone under a bound. Do not use broad `pkill`, `killall`, or a non-unique tmux server.
3. Only after host/tmux termination is confirmed, recursively remove the temporary root. This removes both archives, the installed CLI/plugin/core, generated lockfile/config/fixture, and XDG data together.
4. Run the same cleanup after pack, install, import, launch, render, or assertion failure. Preserve the original failure and append cleanup diagnostics if cleanup also fails.
5. Leave no package-directory tarball, temporary install, tmux server/socket, OpenCode host, daemon, music-session runtime file, or log.

The deterministic session-media fixture should prevent a daemon/provider launch. Do not add process-name-wide cleanup to compensate for an ownership bug.

### 7. Run only the phase verification

Run the exact commands below. If they pass, report the exact installed CLI version/path, isolated package resolutions, retained UI scenarios, and cleanup success. Do not run Pi, documentation, full-workspace, or mixed-host gates in this phase.

## Files to touch

- `packages/opencode-music-player/scripts/package-smoke.ts`

## Files not to touch

- `packages/opencode-music-player/package.json`
- `packages/opencode-music-player/project.json`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/ui.tsx`
- `packages/opencode-music-player/artwork.ts`
- `packages/opencode-music-player/artwork.tsx`
- `packages/opencode-music-player/waveform.tsx`
- `packages/opencode-music-player/tests/**`
- `packages/music-core/**`
- `packages/pi-music-dock/**`
- `README.md`
- `packages/opencode-music-player/README.md`
- `packages/music-core/README.md`
- `packages/pi-music-dock/README.md`
- `docs/music-session-architecture.html`
- `package.json`
- `bun.lock`
- `.apnea/state.json`
- Any unrelated dirty file or generated archive/install/config/lockfile

## Acceptance checks

- The smoke derives exact OpenCode version `0.0.0-next-17386` from `dependencies["@opencode-ai/plugin"]`; the source pin and package manifest remain unchanged.
- Matching `@opencode-ai/cli` and `@opencode-ai/plugin` versions are installed inside the temporary project.
- The launched `opencode2` is the realpathed temporary `node_modules/.bin/opencode2`, remains beneath the isolated install, and reports exactly the manifest-selected version. A global or arbitrary `PATH` binary cannot pass.
- Packed OpenCode plugin and packed music core resolve by package name beneath the isolated install and not from workspace source.
- The exact pinned host loads the real packed plugin with the installed-only deterministic session seam and passes the existing expanded, paused, collapsed, narrow, and smallest presentation assertions.
- Exact host/tmux resources are terminated before deleting their files; both archives, temporary install, generated content, and unique tmux resources are removed on success and failure.
- No daemon, provider handle, host process, tmux server, tarball, socket, marker, bind reservation, log, or temporary install remains because of the smoke.

## Verify commands

Run from the repository root:

```sh
bunx nx run opencode-music-player:smoke --skip-nx-cache
! find packages/opencode-music-player -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
jj diff --summary
jj status
```

The smoke output must identify the exact installed OpenCode pin/binary, confirm isolated packed plugin/core resolution, report the existing app/sidebar presentation success, and report cleanup success without relying on the currently installed global `opencode2`.

## Dependencies

- Approved packed-core Phase 1 at `863c6e7b`.
- Existing `opencode-music-player:smoke` target and `packages/opencode-music-player/scripts/package-smoke.ts` UI fixture/assertions.
- Exact source manifest pin `@opencode-ai/plugin@0.0.0-next-17386`.
- Bun package installation and `tmux` on macOS.

## Non-goals

- Changing the OpenCode version, accepting a semver range, modifying dependencies in the published package, or updating `bun.lock`.
- Changing plugin/controller/session behavior, Effect v4 code, UI, controls, shortcuts, artwork, waveform, layout, or host integration.
- Starting a real music-session daemon/provider, testing live media, or adding presentation scenarios.
- Core package changes, Pi package/smoke changes, documentation, full repository checks, mixed-host verification, or PR-description work.
- Committing, squashing, pushing, publishing, opening a PR, editing `.apnea/state.json`, or cleaning unrelated worktree changes.
