# Local audio-reactivity prototype

**Throwaway code. Do not merge or publish it.** This tests real signal input and interchangeable terminal styles before changing the released plugin. The [production integration plan](../../../../docs/music-audio-visualization-plan.md) defines the separate daemon implementation and release gates.

Run from the repository root:

```sh
bun packages/opencode-music-player/prototypes/audio-reactive/run.ts --source cliamp
```

Start CLIAMP separately and play a track you choose. Select Bars, BarsDot, Mirror, or ClassicPeak in CLIAMP. Other source modes are rejected because their spectrum freshness has not been established here. This prototype sends no playback, volume, queue, or visualizer commands to CLIAMP.

In the prototype terminal, press `v` to cycle styles and `q` to exit. CLIAMP's reviewed feed supports spectrum and mirrored spectrum. Scope and stereo meters display unavailable instead of inventing their data. The preview uses six rows when the terminal is tall enough and one row otherwise. In one row, the scope becomes an explicitly labeled amplitude envelope; the compact meters retain both channels.

No socket was available during the initial check. Installation alone does not provide a running analysis feed. The prototype exits with the CLIAMP error rather than silently using generated animation.

## Native source, after the CLIAMP check

The native prototype requires macOS 14.2+ and an installed Xcode compiler/SDK. It uses the installed compiler directly because this Mac's `xcrun` launcher fails. It does not repair, replace, or install developer tools.

List audio process identities without capturing them:

```sh
bun packages/opencode-music-player/prototypes/audio-reactive/run.ts --list
```

Only after selecting and approving the **actual music output process**, run the following command with that process's numeric PID:

```sh
bun packages/opencode-music-player/prototypes/audio-reactive/run.ts --source native --pid 12345 --seconds 15
```

`12345` is a placeholder, not a recommended source. Native mode may prompt for macOS system-audio permission. Do not authorize an unknown app. Inspect the named request before accepting it.

This captures **all output audio from explicitly selected process objects**, not a specific song or browser tab. Do not select calls, microphone software, a global audio service, or a shared browser helper whose ownership is unresolved. The standalone preview requires a PID. The sidebar's Auto option resolves one directly identifiable music process on Start and stops if Now Playing changes; it does not automatically capture the next app or guess which WebKit helper belongs to Kaset. If the selected identity disappears, it stops; restart only after selecting the correct new identity.

Native mode provides all four styles from measured samples: spectrum, mirrored spectrum, a time-domain min/max-envelope scope, and left/right RMS meters. The scope is a reduced window, not a calibrated oscilloscope or stereo phase display. The meters show dBFS, not calibrated VU or LUFS.

## Local OpenCode sidebar

Build the local plugin and native helper:

```sh
bun packages/opencode-music-player/prototypes/audio-reactive/build-plugin.ts
```

Add the printed absolute `prototypes/audio-reactive/dist` directory to `plugins` in `~/.config/opencode/cli.json`. Preserve your existing entries. The preview appears as **REAL AUDIO · LOCAL PROTOTYPE** and starts with capture off. Remove that local entry to disable it. Rebuild after changing prototype code; keep this checkout available while the preview is enabled.

- `/audio-source`: select CLIAMP's exported spectrum, Kaset's attributed WebKit audio, a listed native music process, or Auto.
- `/audio-style`: choose spectrum, mirror, scope, or stereo meters. CLIAMP export disables styles for which it supplies no data.
- `/audio-start`: begin a bounded 30-second preview. Native capture confirms the exact source before starting and revalidates it afterward.
- `/audio-stop`: stop the preview and discard its visible signal. Source selection also stops capture while the dialog is open.

Source, Style, Start, and Stop buttons provide the same actions. The sidebar uses six, four, or one visualization rows according to terminal height. Changing style reuses the same helper; changing source requires another Start. Auto refuses unresolved helper processes and stale selections. Current source-list candidates are a limited prototype set, not a tested compatibility list.

The preview is a separate plugin instance per OpenCode window, not yet the proposed singleton-daemon integration. It captures only after an explicit Start in that window. The released music plugin remains installed independently.

### Try Kaset in the sidebar

Use the local plugin setup above. Play a song in Kaset; no local song file or amplitude profile is needed.

1. Run `/audio-source` and choose **Kaset: attributed WebKit audio**. The selector requires exactly one active WebKit GPU process with Kaset's mapped cache path. It refuses missing or ambiguous attribution.
2. Check the selected **Kaset (WebKit) · PID …** entry. Run `/audio-start` and confirm that process. The preview captures all output from the selected process for at most 30 seconds.
3. Use `/audio-style` to switch among spectrum, mirror, scope, and stereo meters. Switching style keeps the same helper.
4. Run `/audio-stop` to end the preview early. After Kaset or its WebKit process restarts, select the source again. The preview does not capture a replacement automatically.

The Kaset entry stays pinned to its selected Core Audio process. It does not depend on Now Playing metadata remaining on the WebKit PID; Kaset can report its main app instead. Do not use **Auto** for this path. The cache association was tested locally; it is not a production ownership contract.

Confirm that the bars follow the music and settle during a pause. Nacho confirmed that this live Kaset sidebar works on his Mac. Restart recovery, another WebKit app's isolation, and sustained capture remain unverified.

### Hands-on checks

1. Start CLIAMP and play a track. In OpenCode, use `/audio-source` and select the native `cliamp · PID …` entry for all four styles. The exported-spectrum entry supports only bars and mirror.
2. Run `/audio-start`, then use `/audio-style` while the preview is active. Capture stops automatically after 30 seconds; `/audio-stop` ends it sooner.
3. During a preview, switch to headphones or another output when convenient. Record whether the signal continues, stops, or reports an error. One local headphone/output-switching test worked; broader device recovery remains unverified.
4. Restart CLIAMP when convenient. The old process selection must not capture a new process automatically. Select the new PID and start another preview. This checks the actual player's lifecycle beyond the owned-tone experiment.

These checks are manual to avoid unexpectedly changing the user's audio route or restarting their player.

Nacho confirmed that the live sidebar worked and looked good. Headphone/output switching worked in the local test. After an actual CLIAMP restart, starting capture again worked. The animation stopped around that restart, but the cause was not established: source exit and the 30-second limit remain possible. This verifies explicit local recovery, not uninterrupted capture or automatic restart.

## Boundaries

- No physical input devices or microphone fallback. The private aggregate contains only the explicit unmuted tap; hardware subdevices and unexpected tap composition are rejected before input starts.
- The standalone and sidebar visualizers issue no playback commands, replacement audio output, default-device changes, driver installation, or global system tap. The explicitly run isolation/lifecycle experiments below use short synthetic tones; the isolation experiment temporarily pauses and resumes CLIAMP.
- No PCM files or uploads. Samples remain in a bounded in-memory ring. Feature frames travel over the helper's local stdout pipe and are not written to a recording file.
- Native capture runs for at most 30 seconds, including startup. An independent no-grace helper deadline covers blocked startup/output; the parent also enforces termination. Normal exit stops I/O before writing final status and destroys the aggregate and tap. Hard deadline termination is a prototype fallback, not production cleanup evidence.
- Silence, no callback, permission denial, and unresolved source are not interchangeable. A successful setup alone does not verify capture; the live source must provide measurable signal.
- The helper uses an embedded purpose string and ad hoc signature for local testing only. Stable signed distribution, permission attribution across updates, helper-process attribution, broad device/app compatibility, and sustained performance remain unverified.
- The published OpenCode music-player package is unchanged. Enabling the optional local sidebar adds one removable local plugin entry. There is no shared-daemon integration yet.

## Checks

```sh
bun packages/opencode-music-player/prototypes/audio-reactive/run.ts --self-test
```

This uses a synthetic 1 kHz tone in the left channel and then silence. It checks real FFT/level processing without playing or recording audio. It is explicitly **not live-capture verification**.

For an unattended, bounded check after the real source is ready:

```sh
bun packages/opencode-music-player/prototypes/audio-reactive/run.ts --source cliamp --seconds 5 --check
```

The summary reports received frames and nonzero feature frames. It does not dump waveform samples or claim that feature arrival proves fresh music or source isolation. Confirm changes during playback, pause/silence, and other-app audio before calling the integration verified.

The following manual experiments have audible or playback effects and should be run only when intended:

```sh
# Temporarily pause/resume CLIAMP and emit a three-second quiet other-process tone.
bun packages/opencode-music-player/prototypes/audio-reactive/isolation.ts --pid 12345

# Emit a three-second quiet owned tone and verify capture stops when it exits.
bun packages/opencode-music-player/prototypes/audio-reactive/lifecycle.ts
```

The sidebar fixture smoke opens an isolated OpenCode instance with a synthetic helper and does not capture audio:

```sh
bun packages/opencode-music-player/prototypes/audio-reactive/sidebar-smoke.ts
```

## Current local evidence

- Native Swift compilation passed with warnings treated as errors, using the installed compiler and SDK directly. The generated binary is ad hoc signed. No developer-tool installation or system configuration changed.
- The synthetic check verifies a measurable spectrum peak near 1 kHz, a left-channel RMS level near 0.177 with a silent right channel, a signed mono envelope, and zero spectrum/envelope during silence.
- Fixture inputs rendered all four styles, including both L/R meters in the one-row layout. Missing waveform data remains unavailable. Non-finite/oversized arrays and unverified CLIAMP source modes are rejected.
- An isolated mock executable verified successful valid frames, failure after a valid frame, failure without frames by the deadline, and rejection of stale waveform-mode bands. These are fixture results, not real CLIAMP playback.
- An invalid native PID was rejected before tap creation, with a failing check exit. Process-list inspection was metadata-only.
- After CLIAMP started, its real BarsDot feed was verified: the bounded five-second check accepted 99 frames, all with nonzero spectrum. CLIAMP 2.3.0's source confirms BarsDot uses spectrum analysis. No playback commands were sent.
- Regression tests cover BarsDot acceptance, unchanged spectrum values, both bar renderers, rejection of stale raw-sample modes, and failed responses. Type-checking and workspace lint pass.
- A user-approved, ten-second native capture of the running CLIAMP process succeeded on this Mac: 177 feature frames, 175 with nonzero spectrum, normal stopped status, and exit zero. The native feature bundle includes the scope envelope and stereo levels needed by all four renderers. Capture used explicit process-object inclusion and the checked tap-only aggregate; no playback commands were sent.
- The user-approved CLIAMP isolation experiment passed: 37 paused frames and 63 frames during the separate quiet test tone had RMS zero. Nonzero CLIAMP signal returned after resume. Playback was restored to its original playing state. This is one controlled other-process test, not a guarantee about every app.
- The owned-source exit experiment passed: 45 nonzero frames were observed, then capture stopped with `source identity changed` after approximately 3.1 seconds instead of rebinding. Nacho later confirmed explicit capture recovery after a real CLIAMP restart; uninterrupted capture and automatic rebinding remain unverified.
- Isolated OpenCode 2.0.22 UI checks verified off-by-default behavior, source selection, confirmation, all four styles, compact stereo layout, one helper across style changes, Stop, and stale-selection rejection with synthetic feature fixtures. These do not replace live sidebar verification.
- Lifecycle regressions reproduce and prevent overlapping Starts/source changes, and prevent Auto from capturing a source that changed during confirmation. Native Start also passes the approved audio-object identity to the helper.
- The local sidebar was added to the user's CLI configuration and OpenCode reported successful plugin reconciliation. No capture helper was running after activation. Nacho later confirmed live sidebar interaction, headphone/output switching, and explicit recovery after CLIAMP restart, as recorded above.
- An approved ten-second capture of Kaset's WebKit GPU process received 165 measured feature frames, including spectrum, envelope, and stereo levels. It stopped normally with exit zero. Now Playing parent metadata and the process's mapped Kaset cache path established the tested local association. Nacho subsequently confirmed that the live Kaset sidebar works.
- Kaset's controlled isolation check passed: 38 playing frames had signal, 36 paused frames stayed silent, and 64 frames stayed silent during a separate process's three-second quiet tone. All 56 resumed frames had signal. Playback was restored; capture stopped normally with exit zero. No audio was saved.
- The first isolation attempt stopped when metadata switched from the WebKit PID to Kaset's main PID. The retry accepted either verified Kaset transport identity while keeping capture pinned to the same audio process. This establishes one controlled other-process comparison, not isolation from another WebKit app, restart recovery, or a Linux capture path.
- Sidebar regressions cover selecting the attributed Kaset helper instead of its silent main app, unrelated WebKit rejection, ambiguous-helper rejection, attribution loss during confirmation, and changed Core Audio identity. The extended isolated TUI smoke passed on OpenCode 2.0.23 with synthetic Kaset helper and cache fixtures. It verifies confirmation, the selected PID, compact/full stereo rendering, and Stop without capturing audio. This does not broaden the declared production host contract.
- Permission-prompt attribution, deny/revoke/update behavior, additional players, broader device coverage, and sustained performance remain **untested**. Do not merge this prototype based on these checks alone.
