# Test the local Kaset daemon sidebar

Use this candidate for an explicitly approved local capture test. It connects the sidebar to a shared daemon without per-song files. It is not installed or released. The working prototype keeps its 30-second limit.

One approved [live shared-daemon Kaset test](music-local-daemon-audio-evidence.md) passed beyond 30 seconds, including explicit Stop. Other lifecycle and release checks remain open. Keep the installed preview unchanged until replacement verification is complete.

## Before you start

- Work from the isolated audio checkout, not the checkout containing unrelated artwork changes.
- Use macOS with the installed Xcode compiler and SDK, Bun, and Node. The helper uses macOS 14.2 APIs; that version is not a tested distribution promise.
- Use the existing workspace dependencies. Do not install or repair developer tools for this test.
- Keep the [distribution and permission gates](music-audio-helper-distribution.md) separate. The native helper is ad-hoc signed and excluded from npm packages.
- Obtain separate approval before changing the local OpenCode configuration or capturing Kaset. Approval to implement this candidate does not authorize those actions.

## Build without starting capture

1. Build the local helper from the repository root:

   ```sh
   bun run --cwd packages/music-core build:audio-helper
   ```

2. Build the local sidebar for a separate socket:

   ```sh
   bun run --cwd packages/opencode-music-player build:local-audio --socket /tmp/music-local-kaset.sock
   ```

   The command prints the local plugin directory. It does not install the plugin, start a daemon, or capture audio.

3. Run the synthetic checks:

   ```sh
   bun run --cwd packages/music-core native:check
   bun run --cwd packages/opencode-music-player local-audio:check
   ```

   The UI check needs installed OpenCode and tmux. It creates temporary configuration, a fake media provider, and a real daemon with synthetic helper subprocesses. It changes no personal OpenCode configuration and plays no audio.

## Run the approved live test

Run these steps only after explicit approval. The recorded live test used temporary OpenCode configuration; replacing a personal plugin entry remains a separate action.

1. Start the separate local daemon:

   ```sh
   bun packages/music-core/session/music-sessiond.ts --local-kaset-audio --socket /tmp/music-local-kaset.sock --idle-grace-ms 300000
   ```

   Startup leaves capture off. The flag rejects the installed daemon's socket, including its macOS `/private/tmp` alias. The sidebar connects only to the selected socket. It never launches or replaces a daemon.

2. Stop any active prototype preview. Temporarily replace only its local plugin entry with the directory printed by the sidebar build. Preserve the released music plugin and unrelated entries. Keep a copy of the previous configuration for rollback.

3. Play a song in Kaset yourself. Open the sidebar and run `/live-audio-source`. Choose the daemon-issued **Kaset (WebKit) · PID …** entry. Selection starts no capture.

4. Run `/live-audio-start` and confirm that exact process. A second window needs its own selection and Start to join the current generation. A source conflict does not replace another window's capture.

5. Run `/live-audio-style` to choose spectrum, mirror, scope, or meters. Styles reuse the helper. Scope shows a signed min/max envelope; its one-row form is labeled **envelope**. Meter bars show RMS and ticks show sample peaks. Full meters use dBFS labels; compact meters keep L and R.

6. Run `/live-audio-stop`. Stop ends shared capture for all joined windows. Closing or hiding one sidebar releases only that window's interest. The helper stops when the last joined window leaves, even if metadata-only clients remain connected.

## Verify and restore

Verify that the signal follows Kaset during playback and settles during a user-controlled pause. Check a sustained run beyond 30 seconds, source exit, and explicit restart recovery. Re-select after process loss; the candidate never captures a replacement PID automatically.

The native helper pins the PID, launch time, executable path/signing hash, and Core Audio object. It checks Kaset's mapped WebKit cache association before tap creation, before I/O starts, and during capture. The file walk uses XNU's private `PROC_PIDREGIONPATHINFO2` selector. It worked in metadata-only checks on this Mac; other OS versions remain unverified. This private API is an additional release blocker. Selection rejects missing or ambiguous candidates. Native attribution checks fail closed on changed mappings or scan limits. This cache association is local evidence, not a general browser ownership guarantee.

Stale frames clear the visualization. Silence stays measured zero; missing data never becomes generated animation. Reload preserves only the style. It clears source selection and capture approval.

Each active window renews its five-second capture interest once per second. An expired window loses its interest even if its socket stays open. Another healthy joined window can keep the same capture. After expiry, the sidebar releases its socket; fresh selection opens another connection and requires confirmation again. This prevents delayed same-generation lease status from affecting a new join. Acquisition has a separate 30-second bound; the native adapter can fail sooner. Updated clients refuse unleased capture on older local audio daemons without disrupting playback or replacing the daemon.

Expiry evidence is not replaceable presentation. The daemon preserves it through bounded status queues or closes an overloaded connection. A slow window cannot keep an expired audio lifetime usable by missing that event. Other connections and playback remain independent.

Disposal cancels and joins the plugin's pending dialog waits and commands. The host API cannot close one specific dialog safely, so a host-owned dialog may remain visible. A late answer is ignored and cannot grant capture. A failed or rejected Stop reports that shared Stop is unconfirmed; it does not claim another window's capture ended.

After the test, stop capture, close the local windows, and end the local daemon with Ctrl-C. Restore the previous plugin entry if the candidate fails. Keep the installed preview's 30-second guard until replacement verification is complete.
