---
status: done
---

# Phase 2 package — mixed exact-host live certification

## Intent

Certify exact OpenCode `0.0.0-next-17386` and Pi `0.84.0` simultaneously against the legitimately existing shared music daemon. Use regular Herdr panes as the operator surface. Prove:

- both checkout integrations attach successfully and render the same real track and playback state;
- an OpenCode play/pause action converges in Pi;
- a Pi play/pause action converges in OpenCode;
- Pi `/reload` preserves the existing daemon generation and leaves one healthy Pi music lifecycle;
- normal Pi exit leaves OpenCode attached and able to control playback;
- the user's original playback state is restored;
- after both owned hosts exit, the protected daemon and unrelated clients remain undisturbed.

This is live certification only. Do not change source or history to repair a failure. Do not require final idle shutdown: unrelated clients remain, while the approved Phase 1 `bun run check` already passed deterministic and packed idle-lifecycle smokes.

## Protected resources and fail-closed rules

Treat all of these as pre-existing and protected:

- daemon PID `45621`;
- exact command `node /Users/nachovazquez/work/1-projects/naxodev/ai/packages/music-core/dist/music-sessiond.js`;
- socket `/tmp/naxodev-music-$(id -u)/s.sock`;
- every OpenCode/Pi process, socket client, pane, tab, and runtime root not created by this phase.

Any PID, command, generation, socket identity, UID, or mode mismatch is a blocker. It is never authority to restart, signal, unlink, discover-clean, replace, or start a daemon. Read generation only with `createMusicSessionClient` against an already validated explicit socket. Never use `connectOrStartMusicSession`, a reconnecting probe, startup leases, discovery cleanup, or another API capable of starting or cleaning a daemon.

The coder is explicitly authorized to operate Herdr for this phase, but only through regular panes. Do not create floating panes, use a modal-vim Pi profile, infer Herdr IDs, or close any Herdr resource not created by this phase.

## Files to touch

Only:

- the exact coder-result artifact path supplied by the Phase 2 coder dispatch.

Outside the repository, this phase may create and later remove:

- one fresh, ownership-validated temporary OpenCode install/config root;
- one fresh, ownership-validated temporary `PI_CODING_AGENT_DIR`;
- regular Herdr panes or a tab created by this phase.

## Files not to touch

Do not edit, create, delete, restore, or rewrite:

- anything under `packages/**`;
- `package.json`, `bun.lock`, `nx.json`, scripts, manifests, policy, or tool configuration;
- any documentation or changelog;
- `.apnea/state.json`;
- any prior `.apnea` task, artifact, backup, or history record;
- commit `bd952919`, its ancestors, or unrelated working-copy state;
- global OpenCode or Pi configuration;
- the protected socket, runtime directory, startup marker, bind reservation, daemon process, or unrelated client processes.

Do not create repository-local profiles, installs, logs, screenshots, sockets, archives, or debug scripts. Do not reset or clean the worktree. Do not commit, squash, push, publish, release, or create/update a PR.

## Exact steps

Run repository commands from `/Users/nachovazquez/work/1-projects/naxodev/ai`.

### 1. Confirm the approved Phase 1 handoff and live prerequisites

Phase 1 is approved: the literal `bun run check` exited `0`, and PID `45621`, socket tuple `16777231:1237478212:501:600`, and generation `music-session-zqg8kksdwec` were unchanged during that gate. Do not assume those live values still hold; establish a fresh fail-closed baseline below.

First run this self-contained source/history assertion:

```sh
set -eu
test "$(jj log -r '@- & bd952919' --no-graph -T 'commit_id.short(8)')" = 'bd952919'
test "$(jj log -r 'parents(bd952919) & c78b5b93' --no-graph -T 'commit_id.short(8)')" = 'c78b5b93'
expected="$(printf '%s\n' \
  'M packages/music-core/session/client.ts' \
  'M packages/music-core/session/config.ts' \
  'M packages/music-core/tests/session-client.test.ts' | LC_ALL=C sort)"
test "$(jj diff -r bd952919 --summary | LC_ALL=C sort)" = "$expected"
test -z "$(jj diff --summary | awk '$2 !~ /^\.apnea\// { print; exit }')"
printf 'approved=%s parent=%s\n%s\n' \
  "$(jj log -r bd952919 --no-graph -T 'commit_id.short(8) ++ " " ++ description.first_line()')" \
  "$(jj log -r 'parents(bd952919)' --no-graph -T 'commit_id.short(8)')" \
  "$expected"
```

Use only revset identity checks or `commit_id.short(8)` in history assertions. Never compare default 12-character `short()` output to an eight-character literal.

Then run the host/operator prerequisites:

```sh
set -eu
test "${HERDR_ENV:-}" = 1
herdr --help >/dev/null
herdr pane || true
herdr tab || true
bunx --package @earendil-works/pi-coding-agent@0.84.0 pi --version | grep -qx '0.84.0'
command -v media-control >/dev/null || command -v nowplaying-cli >/dev/null
realpath packages/opencode-music-player
realpath packages/pi-music-dock
```

`herdr pane` and `herdr tab` print their installed command groups and may return a nonzero usage status; the `|| true` is only for those help-group calls. The installed CLI output is authoritative for syntax.

If `HERDR_ENV=1`, exact Pi resolution, a supported media provider, registry access, or active controllable macOS media is unavailable, stop and report the blocker. Do not substitute headless or synthetic evidence.

### 2. Create only owned regular Herdr resources

Record the caller's IDs before creating anything:

```sh
printf 'caller workspace=%s tab=%s pane=%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
herdr pane current --current
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
```

Create a new regular tab in the current workspace with `--no-focus`, repository root as its cwd, and a descriptive label. Read the returned tab and initial-pane IDs from the JSON; do not derive them from display order or examples. Use the initial pane as the persistent inspector. Split only that owned pane to create an OpenCode pane, then split an owned pane again to create a Pi pane. Read each new `pane_id` from its split response.

Representative topology commands, with every placeholder replaced only by an ID returned by Herdr:

```sh
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" --label 'music mixed certification' --no-focus
herdr pane rename <returned-initial-pane-id> 'music inspector'
herdr pane split <returned-initial-pane-id> --direction right --cwd "$PWD" --no-focus
herdr pane rename <returned-opencode-pane-id> 'exact OpenCode'
herdr pane split <returned-opencode-pane-id> --direction down --cwd "$PWD" --no-focus
herdr pane rename <returned-pi-pane-id> 'exact Pi'
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
```

Keep a list of the exact owned tab/pane IDs in the coder result. Inspect layout and resize only owned panes if needed so both host UIs render title, artist, and playback marker without relying on truncated text. Do not create floating panes or alter unrelated panes.

### 3. Establish the protected baseline in the persistent inspector

Run the following definitions and baseline in the owned inspector pane. Keep this shell alive for the entire certification.

```sh
set -eu
daemon_pid=45621
daemon_command='node /Users/nachovazquez/work/1-projects/naxodev/ai/packages/music-core/dist/music-sessiond.js'
socket="/tmp/naxodev-music-$(id -u)/s.sock"
assert_protected_endpoint() {
  test "$(ps -p "$daemon_pid" -o command=)" = "$daemon_command"
  test -S "$socket"
  test "$(stat -f '%u:%Lp' "$socket")" = "$(id -u):600"
  test "$(stat -f '%u:%Lp' "$(dirname "$socket")")" = "$(id -u):700"
  lsof -n -a -p "$daemon_pid" "$socket" >/dev/null
  stat -f '%d:%i:%u:%Lp' "$socket"
}
direct_generation() {
  before="$(assert_protected_endpoint)" || return
  observed="$(MUSIC_SESSION_SOCKET="$socket" bun -e 'import { baselineCapabilities, createMusicSessionClient } from "./packages/music-core/index.ts"; const socketPath = process.env.MUSIC_SESSION_SOCKET; if (!socketPath) throw new Error("missing validated socket"); const client = await createMusicSessionClient({ socketPath, clientId: `mixed-cert-${process.pid}`, hostKind: "test", capabilities: [...baselineCapabilities] }); try { console.log(client.daemonInstanceId) } finally { client.dispose() }')" || return
  after="$(assert_protected_endpoint)" || return
  test "$after" = "$before"
  test -n "$observed"
  printf '%s\n' "$observed"
}
baseline_socket="$(assert_protected_endpoint)"
baseline_generation="$(direct_generation)"
test "$(assert_protected_endpoint)" = "$baseline_socket"
check_attachment() {
  test "$(assert_protected_endpoint)" = "$baseline_socket"
  test "$(direct_generation)" = "$baseline_generation"
  test "$(assert_protected_endpoint)" = "$baseline_socket"
}
check_attachment
printf 'protected: pid=%s generation=%s socket=%s\n' \
  "$daemon_pid" "$baseline_generation" "$baseline_socket"
baseline_lsof="$(lsof -n -a -p "$daemon_pid" "$socket")"
printf '%s\n' "$baseline_lsof"
```

Record the fresh baseline PID, exact command, socket tuple, socket/runtime-directory ownership and modes, generation, and complete `lsof` rows. If they differ from the expected protected identity or any helper call fails, stop without launching either host and without cleanup/startup actions.

Run `check_attachment` immediately before and after every host launch, transport action, reload, and host exit below. A failed checkpoint ends the certification; it does not authorize recovery actions against the daemon.

### 4. Install and launch exact isolated OpenCode

In the owned OpenCode pane, run this block. It creates a fresh direct child of the canonical temporary base, installs the exact beta CLI with its trusted lifecycle hook, proves the binary resolves beneath that install, writes only isolated config, and launches the local checkout plugin. Do not use the mutable global `opencode2` binary or global config.

```sh
set -eu
tmp_base="${TMPDIR:-/tmp}"; tmp_base="$(realpath "$tmp_base")"
oc_root="$(realpath "$(mktemp -d "$tmp_base/opencode-next-17386.XXXXXX")")"
cleanup_oc() {
  test -e "$oc_root" || return 0
  test -d "$oc_root" && test ! -L "$oc_root"
  test "$(stat -f '%u' "$oc_root")" = "$(id -u)"
  test "$(realpath "$(dirname "$oc_root")")" = "$tmp_base"
  case "$(basename "$oc_root")" in opencode-next-17386.*) ;; *) return 1 ;; esac
  rm -rf -- "$oc_root"
}
trap cleanup_oc EXIT
cat >"$oc_root/package.json" <<'JSON'
{"private":true,"dependencies":{"@opencode-ai/cli":"0.0.0-next-17386"},"trustedDependencies":["@opencode-ai/cli"]}
JSON
(cd "$oc_root" && bun install)
oc_boundary="$(realpath "$oc_root/node_modules")"
oc_bin="$(realpath "$oc_root/node_modules/.bin/opencode2")"
case "$oc_bin" in "$oc_boundary"/*) ;; *) echo 'temporary OpenCode binary escaped install root' >&2; exit 1 ;; esac
test -x "$oc_bin"
test "$("$oc_bin" --version)" = 'opencode2 v0.0.0-next-17386'
mkdir "$oc_root/config"
plugin="$(realpath packages/opencode-music-player)"
printf '{"plugins":["%s"]}\n' "$plugin" >"$oc_root/config/cli.json"
test "$(cat "$oc_root/config/cli.json")" = "{\"plugins\":[\"$plugin\"]}"
printf 'oc_root=%s oc_bin=%s plugin=%s\n' "$oc_root" "$oc_bin" "$plugin"
OPENCODE_CONFIG_DIR="$oc_root/config" \
OPENCODE_CONFIG_PROJECT_DISABLE=1 \
OPENCODE_DISABLE_PROJECT_CONFIG=1 \
OPENCODE_DISABLE_AUTOUPDATE=1 \
OPENCODE_DISABLE_MODELS_FETCH=1 \
"$oc_bin" --standalone --log-level error "$PWD"
```

Run `check_attachment` immediately before sending this block and again only after OpenCode displays a stable UI. Record:

- returned OpenCode pane ID;
- canonical `oc_root`, exact `oc_bin`, exact version, and absolute checkout plugin path;
- no `1 plugin failed`, resolution error, or music startup error;
- the rendered compact/sidebar music marker, title, artist, and play/pause state;
- `herdr pane process-info <opencode-pane-id>` and an ANSI-preserving visible read:

```sh
herdr pane process-info <opencode-pane-id>
herdr pane read <opencode-pane-id> --source visible --format ansi
```

Do not issue a transport action yet.

### 5. Launch exact Pi with an isolated profile

In the owned Pi pane, run this block:

```sh
set -eu
tmp_base="${TMPDIR:-/tmp}"; tmp_base="${tmp_base%/}"
pi_root="$(mktemp -d "$tmp_base/pi-mixed.XXXXXX")"
cleanup_pi() {
  test -e "$pi_root" || return 0
  test -d "$pi_root" && test ! -L "$pi_root"
  test "$(stat -f '%u' "$pi_root")" = "$(id -u)"
  test "$(realpath "$(dirname "$pi_root")")" = "$(realpath "$tmp_base")"
  case "$(basename "$pi_root")" in pi-mixed.*) ;; *) return 1 ;; esac
  rm -rf -- "$pi_root"
}
trap cleanup_pi EXIT
extension="$(realpath packages/pi-music-dock)"
test "$(bunx --package @earendil-works/pi-coding-agent@0.84.0 pi --version)" = '0.84.0'
printf 'pi_root=%s extension=%s\n' "$pi_root" "$extension"
PI_CODING_AGENT_DIR="$pi_root" PI_OFFLINE=1 \
  bunx --package @earendil-works/pi-coding-agent@0.84.0 pi \
  --no-extensions -e "$extension"
```

This uses an empty profile, offline startup, disabled extension discovery, and only the absolute checkout extension. Do not add a modal editor or another profile.

Run `check_attachment` immediately before launch and after Pi displays a stable UI. Record:

- returned Pi pane ID;
- exact Pi version, canonical profile path, and absolute checkout extension path;
- no unclassifiable-peer, extension-load, provider, or reconnect error;
- exactly one rendered music status line with marker, title, artist, and play/pause state;
- `herdr pane process-info <pi-pane-id>` and the ANSI-preserving visible read:

```sh
herdr pane process-info <pi-pane-id>
herdr pane read <pi-pane-id> --source visible --format ansi
```

### 6. Prove simultaneous shared state

With both host processes alive, run `check_attachment`, read both visible panes, and record one timestamped checkpoint. Require the same real title, artist, track identity, and play/pause state in both UIs. The playback marker means the next action: `⏸` while currently playing and `▶` while paused.

Record the user's original playback state as `original_state` and the stable track identity as at least the exact title/artist pair shown by both hosts. Do not proceed unless active media is controllable and the two UIs agree. If the track, provider, or state changes externally during a step, stop and report the environmental interference rather than blindly issuing another action.

Also record steady-state daemon `lsof` output with both owned hosts attached. This is comparison evidence for reload and exit lifecycle; do not signal any listed process.

### 7. Prove controls in both directions

For every action below:

1. run `check_attachment` immediately before it;
2. record both panes and the current track/state;
3. send exactly one action;
4. wait for both UIs to converge on the expected opposite state without issuing another action;
5. reread both panes, timestamp the observation, and run `check_attachment` again.

First send OpenCode's play/pause shortcut to only the owned OpenCode pane:

```sh
herdr pane send-keys <opencode-pane-id> ctrl+shift+p
```

Require Pi to converge from `original_state` to the opposite state on the same track. Then send Pi's reliable slash command to only the owned Pi pane:

```sh
herdr pane run <pi-pane-id> '/music'
```

Require OpenCode to converge back to `original_state` on the same track. Do not use next/previous controls in this phase.

### 8. Prove Pi `/reload` preserves generation and one lifecycle

At stable `original_state`:

1. run `check_attachment` and capture both panes;
2. record `herdr pane process-info <pi-pane-id>` and daemon `lsof` output;
3. send exactly one reload command:

   ```sh
   herdr pane run <pi-pane-id> '/reload'
   ```

4. wait until Pi returns to a healthy, settled UI;
5. rerun `herdr pane process-info`, read both panes, run `check_attachment`, and record daemon `lsof` again.

Acceptance at this checkpoint requires:

- the same daemon PID, exact command, socket tuple, and `daemonInstanceId`;
- the same one Pi host process in the owned pane;
- one, not duplicated, rendered Pi music status/client lifecycle;
- the same track and playback state in Pi and OpenCode;
- OpenCode remains healthy throughout;
- steady daemon socket-client count returns to the same value seen immediately before reload, with no accumulating Pi connection.

Do not interpret the expected Pi client disposal/recreation during reload as authority to touch the daemon.

### 9. Prove Pi-exit isolation and restore playback

Run `check_attachment`, record both UIs, then exit Pi normally by submitting its built-in command:

```sh
herdr pane run <pi-pane-id> '/quit'
```

Do not signal Pi or close its pane as a substitute for normal exit. Wait for the exact Pi process to return to its owned shell. Run the ownership-checking cleanup function in that pane and disable its fallback trap:

```sh
cleanup_pi
trap - EXIT
```

Confirm `pi_root` no longer exists, then run `check_attachment`. Record that OpenCode still renders the same track and `original_state`, along with OpenCode process info and daemon `lsof` output.

Now prove OpenCode can still control playback without Pi:

1. run `check_attachment`;
2. send one OpenCode `ctrl+shift+p` and observe the same track reach the opposite of `original_state` in OpenCode;
3. run `check_attachment`;
4. send one corresponding OpenCode `ctrl+shift+p` and observe exact restoration to `original_state`;
5. run `check_attachment` again.

Do not exit OpenCode unless the original playback state has been restored. If external playback changes make exact restoration ambiguous, stop and report rather than guessing.

### 10. Exit owned OpenCode and prove the original daemon remains

Exit only this run's OpenCode through its built-in `/quit` command and wait for the exact process to return to its owned shell:

```sh
herdr pane run <opencode-pane-id> '/quit'
```

Do not signal it and do not close its pane as a substitute. Then run in the returned OpenCode shell:

```sh
cleanup_oc
trap - EXIT
```

Confirm `oc_root` no longer exists. In the persistent inspector, run:

```sh
check_attachment
final_lsof="$(lsof -n -a -p "$daemon_pid" "$socket")"
printf 'final: pid=%s generation=%s socket=%s\n' \
  "$daemon_pid" "$baseline_generation" "$baseline_socket"
printf '%s\n' "$final_lsof"
test "$final_lsof" = "$baseline_lsof"
```

The final `lsof` equality is against the pre-host baseline captured after the short-lived generation probe had disposed. It proves the protected daemon's original socket rows/unrelated attachments were not replaced by this phase. If unrelated clients naturally change during certification, report the mismatch as a blocker; do not clean or recreate anything.

Do not wait for or claim idle shutdown. PID `45621`, its exact command, socket identity/ownership, and generation must remain present.

### 11. Close only owned Herdr resources and report

After both host processes have exited normally, both validated temporary roots are gone, and the final inspector checkpoint has passed, close only the panes/tab whose IDs were returned by this phase. Never close the caller's pane or another user's resource. Record the close commands and statuses.

In the exact dispatched coder-result artifact, include:

- all returned Herdr tab/pane IDs and confirmation they were regular and owned;
- exact OpenCode install root, binary path/version, config path, and checkout plugin path;
- exact Pi version, isolated profile, and checkout extension path;
- timestamped before/after values for every `check_attachment` checkpoint;
- title, artist/track identity, and playback marker/state from both UIs at simultaneous startup, each control, reload, Pi exit, post-Pi OpenCode controls, and final restoration;
- OpenCode and Pi process info before/after reload and exit;
- daemon `lsof` observations before hosts, with both hosts, around reload, after Pi exit, and after OpenCode exit;
- normal host exit and ownership-validated root cleanup evidence;
- every command's status and any blocker or residual risk.

Do not overclaim visual evidence that was truncated or not observed.

## Final verify command

After all live work and cleanup, run this self-contained repository assertion from the repository root:

```sh
set -eu
test "$(jj log -r 'bd952919 & ancestors(@)' --no-graph -T 'commit_id.short(8)')" = 'bd952919'
test "$(jj log -r 'parents(bd952919) & c78b5b93' --no-graph -T 'commit_id.short(8)')" = 'c78b5b93'
expected="$(printf '%s\n' \
  'M packages/music-core/session/client.ts' \
  'M packages/music-core/session/config.ts' \
  'M packages/music-core/tests/session-client.test.ts' | LC_ALL=C sort)"
test "$(jj diff -r bd952919 --summary | LC_ALL=C sort)" = "$expected"
test -z "$(jj diff --summary | awk '$2 !~ /^\.apnea\// { print; exit }')"
git diff --check
jj status
```

## Acceptance checks

Phase 2 is accepted only when all of the following are true:

- OpenCode evidence comes from a fresh isolated exact `0.0.0-next-17386` install with `trustedDependencies`; neither mutable global binary nor global config is used.
- Pi is exact `0.84.0`, offline, and uses a fresh isolated profile with only the absolute checkout extension loaded.
- Both integrations are healthy simultaneously in regular owned Herdr panes and display the same real track and playback state from the protected daemon.
- One OpenCode play/pause action converges in Pi, and one Pi `/music` action converges in OpenCode.
- Pi `/reload` preserves daemon PID, command, generation, and socket identity, while leaving one healthy Pi process/status/client lifecycle and healthy OpenCode.
- Normal Pi exit leaves OpenCode healthy and able to toggle playback twice, with the exact original state restored.
- Both owned hosts exit normally; only ownership-validated temporary roots and owned Herdr resources are removed.
- Final PID `45621`, exact command, socket identity/ownership, runtime-directory ownership, `daemonInstanceId`, and baseline unrelated socket rows are unchanged.
- No unrelated process is signaled or cleaned, and no final idle-shutdown claim is made.
- Approved commit `bd952919` and its exact three-path content remain in history; the working-copy child remains free of non-Apnea changes.
- Only the exact dispatched coder-result artifact is written in the repository.

A certification failure is evidence for rework, not permission to edit source, weaken checks, restart the daemon, or disturb unrelated clients.

## Dependencies

- Approved green Phase 1 result and review.
- `HERDR_ENV=1` and installed Herdr regular-pane controls.
- Registry access for the fresh exact OpenCode install and exact Pi resolution.
- Active controllable macOS media through `media-control` or supported `nowplaying-cli` fallback.
- Existing protected PID `45621`, generation, socket, and unrelated clients remain healthy throughout.

## Non-goals

- Source, test, docs, package, lockfile, configuration, or history changes.
- Synthetic, RPC, print, JSON, or other headless substitution for live rendered host evidence.
- Global OpenCode/Pi installation or configuration.
- Next/previous track actions or provider switching.
- Daemon startup, restart, signaling, unlinking, discovery cleanup, replacement, or final idle shutdown.
- Floating panes, modal-vim profiles, inferred Herdr IDs, or closing unrelated panes/tabs.
- Commits, squashes, pushes, publication, releases, or PR creation/update.
