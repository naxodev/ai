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

   The six checks cover PCM extraction, shutdown ordering, permission policy, source guards, discovery ordering, and native denial exit 77. PCM fixtures cover interleaved and planar stereo, tone, silence, and invalid-rate rejection. Source fixtures reject absent or duplicate PIDs, missing displays, and broadened or mismatched filters. They preserve the original failure reason and check that native checkpoint names match the recorder's allowlist. The discovery fixture rejects changed identity or ownership before consuming content and verifies that discovery dispatch cannot call capture. They construct no stream and query no shareable content.

3. Run the twenty-six offline regressions:

   ```sh
   bun test packages/music-core/prototypes/sck-audio/*.test.ts
   ```

   These use fake process boundaries, fixed fake catalogs from real Bun subprocesses, and real temporary Unix sockets. They verify initial denial, silence, revocation, generic failure, explicit Stop, and pipe/heartbeat races through the daemon and sidebar model. An isolated import check blocks live server startup and verifies imports cannot start a probe. Diagnostic checks reject unknown text and preserve fixed native failure reasons and source checkpoints across a fast exit. Metadata checks keep the recorder's scope open and reject a source without running output. A concurrent file-claim test prevents a second trace attempt. They do not mount OpenCode or establish real macOS permission behavior.

4. Check the prototype's own TypeScript project:

   ```sh
   bunx tsc --noEmit -p packages/music-core/prototypes/sck-audio/tsconfig.json
   ```

   Workspace lint also covers these files. The core package's TypeScript configuration excludes this prototype directory, so its regular type check alone is insufficient.

## Prepared live paths

Live capture and permission changes require separate approval under the [local test guide](../../../../docs/music-local-daemon-audio.md#before-you-start). The build and offline checks do not grant that approval.

The isolated app uses bundle ID `dev.naxo.music.sck-matrix.20261011`. Its deny, allow, and revoke buttons run `probe.ts`. Each probe starts a real temporary daemon graph and the sidebar model. It uses a fake playback provider and sends no playback commands. It records counts, peak RMS, active-state evidence, and fixed status messages in `dist/live-evidence`. It saves no PCM or feature arrays.

The probe stops after 15 seconds. The native helper begins shutdown one second before its own 15-second deadline and has an independent forced-exit backstop. The app terminates a stuck probe at 17 seconds and forces it down at 19 seconds. Forced termination is abnormal cleanup, never successful release evidence.

The app was registered and launched for the separately approved local matrix below, then stopped and removed during cleanup. Any approved reset must name only that bundle and the relevant AudioCapture or ScreenCapture service. Existing terminal and other-app grants remain outside the experiment.

The recorder now retains at most 64 fixed native diagnostic reasons and timestamps. Each helper inspects at most 4096 stderr bytes, accepts exact allowlisted status lines, and retains no arbitrary stderr. One shared diagnostic drain prevents an immediate exit from hiding the reason. After physical exit, diagnostic completion has a 50 ms cap and cannot change the exit code or consent classification. The signed helper and app remain unchanged.

The 50 ms cap bounds the exit-result wait. The owning layer still joins reader cleanup. The fixed live pipe reader removes listeners synchronously; arbitrary test boundaries with blocking finalizers can delay scope closure. The held-cleanup regression verifies that this cleanup does not delay the exit result.

## Local matrix, 2026-10-11 UTC

All four approved probes have run. The allowance is exhausted. The app was copied into an ignored project `dist` directory because Launch Services could not resolve its bundle from `/private/tmp`. Bundle-only AudioCapture and ScreenCapture resets then succeeded.

| Stage             | Duration | Frames | Ever active | Result                            |
| ----------------- | -------- | ------ | ----------- | --------------------------------- |
| Initial denial    | 2.715 s  | 0      | No          | Permission failure; denied.       |
| Grant attempt     | 3.101 s  | 0      | No          | Setup failure; grant present.     |
| Grant retry       | 1.048 s  | 0      | No          | No source selected; no Start.     |
| Final grant retry | 3.123 s  | 0      | No          | Native source-loss; no readiness. |

The denial and granted capture attempts were attributed to `dev.naxo.music.sck-matrix.20261011`. The final attempt's ScreenCapture checks returned allowed (`authValue=2`, `authReason=4`). Narrow TCC logs provide diagnostic evidence only. Runtime permission classification still uses the public ScreenCaptureKit error and clean native exit 77.

The first grant failure's native cause remains unresolved. The first two runs preceded the fixed diagnostic recorder. The third run stopped during source selection and recorded no native diagnostic reason. After user-controlled Kaset playback, the final retry selected a source but returned the fixed native reason `source-loss`. It emitted no features and never reached readiness. That reason does not identify which identity, ownership, enumeration, or filter check failed. It does not prove that ScreenCaptureKit omitted the WebKit PID. No revocation or isolation check has run.

Follow-up metadata-only checks found one verified Kaset process with `runningOutput: false`. The helper's field checks passed, and both plain and instrumented catalogs succeeded. The resolver lists no source without running output; the daemon then returns the generic unavailable status shown as `Helper off: check build`. The same symptom was reproduced through the graph without capture. These later checks explain a current source-selection block; they do not prove the output state at the third probe's timestamp.

The matrix failed its granted-capture criterion. Initial denial passed locally; active revocation, source isolation, and full TUI behavior remain unverified. Keep the prototype separate from the shipped backend. The next investigation must distinguish the source guards before another separately approved live test.

Cleanup verified the original helper, launcher, and plist hashes and the app's strict signature. It stopped the app, reset only its AudioCapture and ScreenCapture choices, unregistered both generated app copies, and removed those copies. No reset targeted Hex or Ghostty. The helper and local JSON summaries remain in ignored `dist/live-evidence` and `dist`; they contain no audio or video. Production capture remains unavailable.

For a later approved full TUI check, build the existing local plugin:

```sh
bun run --cwd packages/opencode-music-player build:local-audio --socket /tmp/music-sck-prototype.sock
```

After separate approval, the matching daemon entry is:

```sh
bun packages/music-core/prototypes/sck-audio/daemon.ts --socket /tmp/music-sck-prototype.sock
```

Startup leaves capture off and refuses the managed production socket. Use temporary OpenCode configuration for the built local plugin. No personal plugin entry has been changed.

## Prepare one source trace without capture

The four-probe matrix above is closed. Its original helper was archived as `dist/live-evidence/matrix-helper` before the diagnostic rebuild. The historical artifact hashes still describe that archived binary.

Build the diagnostic app without registering, launching, or requesting permission:

```sh
bun packages/music-core/prototypes/sck-audio/build-harness.ts --source-trace
```

This creates `dist/Kaset SCK Source Trace.app` with bundle ID `dev.naxo.music.sck-source-trace.20261011`. It has a separate **Request Screen Access** button and one **trace** button. A live request and trace require new approval; the previous four-probe allowance does not apply.

The permission button calls public `CGRequestScreenCaptureAccess` in the app and starts no helper or capture. Its screen-access preflight only controls the trace button. It is not an AudioCapture authorization query. Granting screen access starts no trace. Complete any required Settings change and app restart before clicking trace. Runtime capture still uses the verified source, public ScreenCaptureKit errors, and measured-feature readiness.

The trace uses the same daemon and sidebar model with the same 15-second limits. It adds fixed failure checkpoints for identity, cache ownership, shareable-content discovery, missing or duplicate application matches, display availability, filter membership, and checks before Start or during capture. Checkpoints contain no PIDs, paths, application catalogs, window titles, audio, or video. They identify the failed guard without changing its error or widening its filter.

Before creating a daemon, the trace atomically creates `dist/source-trace-evidence/attempt.json`. An existing marker prevents another attempt, including after app restart. The marker records an attempt; it grants no permission. Results go to `dist/source-trace-evidence/trace-result.json`. Do not remove the marker to retry without another explicit approval.

The diagnostic app was registered and launched for the separately approved trace below, then stopped and removed. Its permission choices were reset during cleanup. Another live request needs new approval.

## Source trace, 2026-10-11 UTC

The user approved permission setup and one 15-second Kaset trace for `dev.naxo.music.sck-source-trace.20261011`.

An initial invocation at 03:03:08 UTC ended during source selection, before calling Start. It saved zero frames and no checkpoint. The user reported that the trace button was unavailable. The files were preserved under `dist/source-trace-evidence/preflight-1`. Metadata-only checks then found one verified source with running output. The preflight marker was archived to finish the original approved capture request. Only the following invocation issued daemon Start.

| Start (UTC)  | Duration | Frames | Ever active | Native checkpoint        |
| ------------ | -------- | ------ | ----------- | ------------------------ |
| 03:10:22.345 | 3.064 s  | 0      | No          | `sck-application-absent` |

The helper passed its identity and cache-ownership checks before discovery. Shareable-content discovery completed, but no returned application matched the selected Kaset WebKit PID. The helper then reported `source-loss`. This guard runs before filter or stream construction, so no `SCStream` was created.

Narrow TCC diagnostics attributed the request to the source-trace app and showed allowed ScreenCapture checks (`authValue=2`, `authReason=4`). Those logs remain diagnostic evidence, not runtime authorization authority. No PIDs, application catalogs, window titles, audio, or video were retained from discovery.

This identifies the failed guard in this run. It does not establish why the PID was absent, rule out process loss during discovery, or prove that ScreenCaptureKit can never expose Kaset WebKit audio. At that revision, the checks after discovery ran after application selection, so they did not run in this failure. The discovery-only preparation below moves those checks before content use. The exact-PID guard and production release gate remain unchanged.

Cleanup verified the reviewed artifact hashes and app signature. It stopped the app, reset only the source-trace bundle's AudioCapture and ScreenCapture choices, and removed both generated app copies. The temporary-copy unregister command returned `-10814`; a subsequent Launch Services dump contained no source-trace bundle identifier. No app, probe, or helper remained running. No permission reset targeted Hex or Ghostty.

The completed trace, sanitized permission diagnostics, preparation/cleanup ledger, and archived helper remain in ignored `dist/source-trace-evidence`. The approved daemon Start request is used; no further live attempt is authorized.

## Prepare a discovery-only continuity check

Build without registering, launching, requesting permission, or inspecting shareable content:

```sh
bun packages/music-core/prototypes/sck-audio/build-harness.ts --source-discovery
```

This creates `dist/Kaset SCK Discovery Check.app`, with bundle ID `dev.naxo.music.sck-discovery.20261011`. Its **Request Screen Access** button requests only the app's screen permission. Its separate **discover** button runs `discovery-probe.ts`. Permission setup and protected discovery require separate approval. The previous trace approval is used.

The runner reads the verified Core Audio catalog first. It accepts exactly one owned Kaset WebKit source, including a paused source. Missing or ambiguous metadata returns `source-unavailable` before claiming an attempt or querying ScreenCaptureKit. In that case, the app enables its discover button again. Open Kaset before retrying the metadata preflight; no playback is required.

For an eligible source, the runner atomically claims `dist/source-discovery-evidence/attempt.json`, then launches the fixed helper with `--discover-sck-source`. The process boundary rejects every capture command. The native mode checks the approved identity and local cache attribution before discovery and again immediately after it. Only after both pairs of checks pass can returned content be used. The capture prototype now shares this ordering, so a missing application cannot skip the second verification.

The discovery mode returns only this bounded summary:

```json
{
  "event": "sck-source-discovery",
  "identityChecks": "passed-before-and-after",
  "attributionChecks": "passed-before-and-after",
  "matchingApplications": 0,
  "displayCount": 1
}
```

The numbers above illustrate the format; they are not live results. This path creates no content filter, stream configuration, `SCStream`, output sink, or audio/video sample buffers. It requests no microphone access and has no global-audio fallback. It retains no PID, executable path, application catalog, or window title from discovery.

The parent operation has an eight-second timeout and reuses the existing one-second SIGTERM and one-second SIGKILL waits. The native discovery command has its own ten-second hard deadline. The app terminates a stuck runner after ten seconds and kills it after twelve. Forced termination and failed cleanup cannot produce checked evidence. The parent preserves a confirmed native permission exit across pipe/heartbeat races; cleanup failure takes precedence.

Results are written to `dist/source-discovery-evidence/discovery-result.json`. The stdout reader accepts at most 4096 bytes and projects only the schema's fixed fields. Diagnostics keep the existing byte and entry caps. Import checks block native work even if an entrypoint accidentally starts during import.

The discovery app was registered and launched for the separately approved check below. It was stopped and removed afterward, and its permission choices were reset. Its offline checks do not clear the production gate.

## Discovery-only result, 2026-10-11 UTC

One approved check ran from 04:25:00.283 to 04:25:02.433 UTC, completing in 2.150 seconds.

| Check                                     | Result                            |
| ----------------------------------------- | --------------------------------- |
| Approved identity                         | Passed before and after discovery |
| Local cache attribution                   | Passed before and after discovery |
| Matching ScreenCaptureKit applications    | 0                                 |
| Returned displays                         | 2                                 |
| Filter, stream, or sample buffers created | None                              |

The selected source identity remained valid at both checks, while the returned application list had no matching PID. This adds direct evidence of a discovery mismatch for a stable verified source in this configuration. The exact-PID capture selector cannot proceed with that result. It does not establish a universal ScreenCaptureKit limitation, explain how the framework groups WebKit audio, or prove that explicit application-scoped targeting would work.

Narrow TCC diagnostics attributed the request to `dev.naxo.music.sck-discovery.20261011` and showed allowed ScreenCapture checks (`authValue=2`, `authReason=4`). Those logs remain diagnostic evidence. The native result came from the public discovery API and before-and-after source verification; no permission database or private TCC interface was used.

The one protected query is used. Cleanup verified the reviewed artifact hashes and app signature, archived the helper, stopped the app, reset only its AudioCapture and ScreenCapture choices, unregistered both generated app copies, and removed them. A Launch Services dump contained no discovery bundle identifier. No app, probe, or helper remained running. No permission reset targeted Hex or Ghostty.

The result, sanitized permission diagnostics, preparation/cleanup ledger, and archived helper remain in ignored `dist/source-discovery-evidence`. No PID, path, application catalog, window title, audio, or video was retained from discovery. Production capture remains unavailable, and no further protected query or capture is authorized.

The [application-targeting design](APPLICATION-TARGETING.md) defines a separate Kaset application scope and its identity, discovery, and isolation requirements. It is not implemented. The current selector below still requires an exact WebKit process match.

## Interpret the result

The native filter accepts exactly one ScreenCaptureKit application whose PID matches the verified Kaset WebKit process. It rechecks launch identity, running code, Core Audio identity, and mapped-cache ownership. Missing or duplicate matches stop acquisition. It never falls back to Kaset's main PID or a display-wide audio source.

The stream registers only an audio output and disables microphone capture. It still uses a display-bound application filter. No screen samples are delivered to this program; this does not prove that screen machinery or screen consent is absent.

Only `SCStreamErrorDomain.userDeclined` becomes native exit 77, after clean teardown. The adapter preserves that cause across concurrent pipe failures. Generic OS permission errors and generic stream stops remain setup failures. Silence remains measured zero. Cleanup errors supersede permission errors with abnormal exit 70.

The native cancellation path retains the Start completion, joins it, then joins Stop after any late success. An unresolved operation fails cleanup. A follow-up review verified those ordering and deadline corrections; real ScreenCaptureKit callback ordering remains untested.

The [authorization report](../../../../docs/music-audio-authorization-research.md#decision-and-proposed-experiment) defines the live acceptance criteria. Initial denial and responsible-app attribution have local evidence above. Minimum sufficient consent, WebKit enumeration, measured Kaset capture, actual isolation, active revocation, and full TUI behavior remain open. If the exact process is absent, record that failure instead of broadening the filter.

Primary API contracts: [application filter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init%28display%3Aincluding%3Aexceptingwindows%3A%29), [stream-stop delegate](https://developer.apple.com/documentation/screencapturekit/scstreamdelegate/stream%28_%3Adidstopwitherror%3A%29), and [stream errors](https://developer.apple.com/documentation/screencapturekit/scstreamerror/code). The installed `SCStream.h`, `SCShareableContent.h`, and `CMSampleBuffer.h` supplied the compiled declarations.
