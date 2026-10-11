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

3. Run the seventeen offline regressions:

   ```sh
   bun test packages/music-core/prototypes/sck-audio/*.test.ts
   ```

   These use fake process boundaries, fixed fake catalogs from real Bun subprocesses, and real temporary Unix sockets. They verify initial denial, silence, revocation, generic failure, explicit Stop, and pipe/heartbeat races through the daemon and sidebar model. An isolated import check blocks live server startup and verifies imports cannot start a probe. Diagnostic checks reject unknown text and preserve a fixed native failure reason across a fast exit. Metadata checks keep the recorder's scope open and reject a source without running output. They do not mount OpenCode or establish real macOS permission behavior.

4. Check the prototype's own TypeScript project:

   ```sh
   bunx tsc --noEmit -p packages/music-core/prototypes/sck-audio/tsconfig.json
   ```

   Workspace lint also covers these files. The core package's TypeScript configuration excludes this prototype directory, so its regular type check alone is insufficient.

## Prepared live paths

Live capture and permission changes require separate approval under the [local test guide](../../../../docs/music-local-daemon-audio.md#before-you-start). The build and offline checks do not grant that approval.

The isolated app uses bundle ID `dev.naxo.music.sck-matrix.20261011`. Its deny, allow, and revoke buttons run `probe.ts`. Each probe starts a real temporary daemon graph and the sidebar model. It uses a fake playback provider and sends no playback commands. It records counts, peak RMS, active-state evidence, and fixed status messages in `dist/live-evidence`. It saves no PCM or feature arrays.

The probe stops after 15 seconds. The native helper begins shutdown one second before its own 15-second deadline and has an independent forced-exit backstop. The app terminates a stuck probe at 17 seconds and forces it down at 19 seconds. Forced termination is abnormal cleanup, never successful release evidence.

The app was registered and launched for the separately approved local matrix below. Any approved reset must name only that bundle and the relevant AudioCapture or ScreenCapture service. Existing terminal and other-app grants remain outside the experiment.

The recorder now retains at most 64 fixed native diagnostic reasons and timestamps. Each helper inspects at most 4096 stderr bytes, accepts exact allowlisted status lines, and retains no arbitrary stderr. One shared diagnostic drain prevents an immediate exit from hiding the reason. After physical exit, diagnostic completion has a 50 ms cap and cannot change the exit code or consent classification. The signed helper and app remain unchanged.

The 50 ms cap bounds the exit-result wait. The owning layer still joins reader cleanup. The fixed live pipe reader removes listeners synchronously; arbitrary test boundaries with blocking finalizers can delay scope closure. The held-cleanup regression verifies that this cleanup does not delay the exit result.

## Local matrix, 2026-10-11 UTC

Three of four approved probes have run. The app was copied into an ignored project `dist` directory because Launch Services could not resolve its bundle from `/private/tmp`. Bundle-only AudioCapture and ScreenCapture resets then succeeded.

| Stage          | Duration | Frames | Ever active | Result                        |
| -------------- | -------- | ------ | ----------- | ----------------------------- |
| Initial denial | 2.715 s  | 0      | No          | Permission failure; denied.   |
| Grant attempt  | 3.101 s  | 0      | No          | Setup failure; grant present. |
| Grant retry    | 1.048 s  | 0      | No          | No source selected; no Start. |

The denial and first grant requests were attributed to `dev.naxo.music.sck-matrix.20261011`. Narrow TCC logs provide diagnostic evidence only. Runtime permission classification still uses the public ScreenCaptureKit error and clean native exit 77.

The first grant failure's native cause remains unresolved. The first two runs preceded the fixed diagnostic recorder. The third run stopped during source selection and recorded no native diagnostic reason. No revocation check has run.

Follow-up metadata-only checks found one verified Kaset process with `runningOutput: false`. The helper's field checks passed, and both plain and instrumented catalogs succeeded. The resolver lists no source without running output; the daemon then returns the generic unavailable status shown as `Helper off: check build`. The same symptom was reproduced through the graph without capture. These later checks explain a current source-selection block; they do not prove the output state at the third probe's timestamp.

The local JSON summaries remain in ignored `dist/live-evidence`; they contain no audio or video. Production capture remains unavailable.

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

The [authorization report](../../../../docs/music-audio-authorization-research.md#decision-and-proposed-experiment) defines the live acceptance criteria. Initial denial and responsible-app attribution have local evidence above. Minimum sufficient consent, WebKit enumeration, measured Kaset capture, actual isolation, active revocation, and full TUI behavior remain open. If the exact process is absent, record that failure instead of broadening the filter.

Primary API contracts: [application filter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init%28display%3Aincluding%3Aexceptingwindows%3A%29), [stream-stop delegate](https://developer.apple.com/documentation/screencapturekit/scstreamdelegate/stream%28_%3Adidstopwitherror%3A%29), and [stream errors](https://developer.apple.com/documentation/screencapturekit/scstreamerror/code). The installed `SCStream.h`, `SCShareableContent.h`, and `CMSampleBuffer.h` supplied the compiled declarations.
