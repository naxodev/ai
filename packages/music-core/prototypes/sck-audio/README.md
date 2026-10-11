# Build the isolated ScreenCaptureKit experiment

This throwaway prototype asks whether public ScreenCaptureKit APIs can provide Kaset-only audio and confirmed permission failures. Production capture remains unavailable. Keep this work on its prototype bookmark until live evidence supports a backend decision.

The helper compiles against the installed macOS 27 SDK with a macOS 15.2 deployment target. Only this Mac's macOS 27.0.1 build has been checked. The target is not a distribution promise. Use the repository's installed dependencies, Bun, and Xcode.

## Build and check without capture

Run from the repository root:

1. Build the helper and isolated app:

   ```sh
   bun packages/music-core/prototypes/sck-audio/build-harness.ts
   ```

   This creates `dist/Kaset SCK Permission Probe.app` beside this guide. It compiles and verifies ad-hoc signatures. It does not register or launch the app.

2. Run native synthetic checks:

   ```sh
   bun packages/music-core/prototypes/sck-audio/check-native.ts
   ```

   The four checks cover PCM extraction, shutdown ordering, permission/source policy, and native denial exit 77. PCM fixtures cover interleaved and planar stereo, tone, silence, and invalid-rate rejection. They construct no stream and query no shareable content.

3. Run the ten offline regressions:

   ```sh
   bun test packages/music-core/prototypes/sck-audio/adapter.test.ts
   ```

   These use fake process boundaries and real temporary Unix sockets. They verify initial denial, silence, revocation, generic failure, explicit Stop, and pipe/heartbeat races through the daemon and sidebar model. An isolated import check blocks live server startup and verifies imports cannot start a probe. They do not mount OpenCode or establish real macOS permission behavior.

4. Check the prototype's own TypeScript project:

   ```sh
   bunx tsc --noEmit -p packages/music-core/prototypes/sck-audio/tsconfig.json
   ```

   Workspace lint also covers these files. The core package's TypeScript configuration excludes this prototype directory, so its regular type check alone is insufficient.

## Prepared live paths

Live capture and permission changes require separate approval under the [local test guide](../../../../docs/music-local-daemon-audio.md#before-you-start). The build and offline checks do not grant that approval.

The isolated app uses bundle ID `dev.naxo.music.sck-matrix.20261011`. Its deny, allow, and revoke buttons run `probe.ts`. Each probe starts a real temporary daemon graph and the sidebar model. It uses a fake playback provider and sends no playback commands. It records counts, peak RMS, active-state evidence, and fixed status messages in `dist/live-evidence`. It saves no PCM or feature arrays.

The probe stops after 15 seconds. The native helper begins shutdown one second before its own 15-second deadline and has an independent forced-exit backstop. The app terminates a stuck probe at 17 seconds and forces it down at 19 seconds. Forced termination is abnormal cleanup, never successful release evidence.

The app has not been launched or registered. Its permission attribution remains unverified. Any approved reset must name only that bundle and the relevant AudioCapture or ScreenCapture service. Existing terminal and other-app grants remain outside the experiment.

For a later approved full TUI check, build the existing local plugin:

```sh
bun run --cwd packages/opencode-music-player build:local-audio --socket /tmp/music-sck-prototype.sock
```

After separate approval, the matching daemon entry is:

```sh
bun packages/music-core/prototypes/sck-audio/daemon.ts --socket /tmp/music-sck-prototype.sock
```

Startup leaves capture off and refuses the managed production socket. Use temporary OpenCode configuration for the built local plugin. No personal plugin entry has been changed.

## Interpret the result

The native filter accepts exactly one ScreenCaptureKit application whose PID matches the verified Kaset WebKit process. It rechecks launch identity, running code, Core Audio identity, and mapped-cache ownership. Missing or duplicate matches stop acquisition. It never falls back to Kaset's main PID or a display-wide audio source.

The stream registers only an audio output and disables microphone capture. It still uses a display-bound application filter. No screen samples are delivered to this program; this does not prove that screen machinery or screen consent is absent.

Only `SCStreamErrorDomain.userDeclined` becomes native exit 77, after clean teardown. The adapter preserves that cause across concurrent pipe failures. Generic OS permission errors and generic stream stops remain setup failures. Silence remains measured zero. Cleanup errors supersede permission errors with abnormal exit 70.

The native cancellation path retains the Start completion, joins it, then joins Stop after any late success. An unresolved operation fails cleanup. A follow-up review verified those ordering and deadline corrections; real ScreenCaptureKit callback ordering remains untested.

The [authorization report](../../../../docs/music-audio-authorization-research.md#decision-and-proposed-experiment) defines the live acceptance criteria. Minimum sufficient consent, WebKit enumeration, actual Kaset isolation, initial prompt denial, active revocation, full TUI behavior, and responsible-app attribution remain untested. If the exact process is absent, record that failure instead of broadening the filter.

Primary API contracts: [application filter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init%28display%3Aincluding%3Aexceptingwindows%3A%29), [stream-stop delegate](https://developer.apple.com/documentation/screencapturekit/scstreamdelegate/stream%28_%3Adidstopwitherror%3A%29), and [stream errors](https://developer.apple.com/documentation/screencapturekit/scstreamerror/code). The installed `SCStream.h`, `SCShareableContent.h`, and `CMSampleBuffer.h` supplied the compiled declarations.
