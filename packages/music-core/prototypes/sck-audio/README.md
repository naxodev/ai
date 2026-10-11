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

3. Run the forty-eight offline regressions:

   ```sh
   bun test packages/music-core/prototypes/sck-audio/*.test.ts
   ```

   These use fake process boundaries, fixed fake catalogs from real Bun subprocesses, and real temporary Unix sockets. They verify initial denial, silence, revocation, generic failure, explicit Stop, and pipe/heartbeat races through the daemon and sidebar model. An isolated import check blocks live server startup and verifies imports cannot start a probe. Diagnostic checks reject unknown text and preserve fixed native failure reasons and source checkpoints across a fast exit. Metadata checks keep the recorder's scope open and reject a source without running output. A concurrent file-claim test prevents a second trace attempt. They do not mount OpenCode or establish real macOS permission behavior.

   Eight paired-reference tests also reject missing or spoofed application proofs, incomplete coverage, invalid controls, contradictory summaries, and failed cleanup. The separate browser directory contains eight more source-page tests.

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

The [application-targeting contract](APPLICATION-TARGETING.md) defines a separate Kaset application scope and its identity, discovery, and isolation requirements. Its discovery-only path is prepared below. The current capture selector still requires an exact WebKit process match.

## Prepare application discovery without a stream

Build the separate helper and unregistered diagnostic app:

```sh
bun packages/music-core/prototypes/sck-audio/build-harness.ts --application-discovery
```

The build validates `/Applications/Kaset.app` through public Security APIs and freezes its signed identifier, Team Identifier, designated requirement, architecture-specific CDHash, and canonical paths. The bounded profile stays in ignored `dist/kaset-application-profile.json`. The helper compiles its exact-byte SHA-256 digest and accepts no profile or signing override. Sandbox trust-service failures stop preparation; they do not relax validation. An attempted discovery prevents this builder from overwriting its reviewed artifacts.

This creates `dist/sck-application-helper` and `dist/Kaset SCK Application Discovery.app`, with responsible bundle ID `dev.naxo.music.sck-application-discovery.20261011`. The helper has a separate signing identifier and contains no sample ring, analyzer, tap, aggregate-device creation, or stream construction. It accepts only fixed metadata, discovery, and synthetic-test commands. The preparation executable is removed after building. The old capture helper remains separate.

Run the new native checks without live metadata or protected discovery:

```sh
bun packages/music-core/prototypes/sck-audio/check-application-native.ts
```

Its five checks use fake identities, content, consent, and child-launch boundaries. They reject signing mismatches, spoofed metadata, replacement code, PID reuse, duplicate or missing candidates, changed or oversized profiles, missing displays, and mismatched ScreenCaptureKit application PIDs. They check verification order before content use and reject capture and preparation flags in the final helper. The launcher fixture proves that permission setup cannot launch a child, including after a grant.

The parent first reads the verified WebKit catalog, including paused sources when checking ambiguity. It requires exactly one witness. A metadata-only preflight then verifies exactly one running Kaset app against the frozen profile. The app identity stays in memory. Missing or invalid metadata returns unavailable before claiming a protected attempt.

A local metadata-only preflight passed for the reviewed application and single WebKit witness. Its extra process guard accepted only catalog and identity commands. The caller deliberately refused the operation before the protected-query claim. It saved fixed eligibility and command-count evidence in ignored `dist/application-discovery-evidence/metadata-preflight.json`; it started no protected query and retained no process identity.

After an atomic claim, the native discovery command rechecks the approved app identity, profile, and single WebKit witness before and after public shareable-content discovery. It accepts exactly one returned Kaset application with the approved PID and at least one display. A zero WebKit PID match remains a valid diagnostic count. No filter, configuration, stream, sink, or sample buffers are created.

The result records only fixed statuses and bounded counts for application matches, witness PID matches, and displays. Explicit projection strips unknown native fields. The shared parent supervisor retains the eight-second operation timeout, bounded physical-exit cleanup, cancellation behavior, and confirmed-permission classification. Cleanup failure supersedes other outcomes. The app has ten-second termination and twelve-second forced-termination backstops.

Run all prototype regressions and its own typecheck using the commands at the start of this guide. The application tests use fake process boundaries. They prove that invalid preflights cannot claim an attempt, invalid results cannot establish eligibility, transient identities are excluded from saved evidence, and cancellation joins physical exit. Import checks also block application discovery from starting during import.

The app was registered and launched for the separately approved discovery check below. It was stopped and removed afterward, and its permission choices were reset. The existing [live test guide](../../../../docs/music-local-daemon-audio.md#before-you-start) governs registration, permission changes, and scoped cleanup. The [application contract](APPLICATION-TARGETING.md#isolation-evidence-required-before-a-backend-decision) still requires later capture and controlled isolation evidence. Production capture remains unavailable.

## Application discovery result, 2026-10-11 UTC

One approved check ran from 13:55:30.718 to 13:55:33.107 UTC, completing in 2.389 seconds.

| Check                                                | Result                            |
| ---------------------------------------------------- | --------------------------------- |
| Pinned Kaset application identity and profile        | Passed before and after discovery |
| Single WebKit witness identity and cache attribution | Passed before and after discovery |
| Matching Kaset applications                          | 1                                 |
| Matching WebKit witness PIDs                         | 0                                 |
| Returned displays                                    | 2                                 |
| Filter, stream, or sample buffers created            | None                              |

The returned application matched the approved Kaset PID and fixed bundle identifier. The separate WebKit witness remained verified at both checks, but its PID had no application match. This establishes eligibility for an explicit application target on this Mac and configuration. It does not establish how ScreenCaptureKit groups WebKit audio, whether Kaset audio would be delivered, or whether unrelated audio would be excluded.

The approved test app used bundle ID `dev.naxo.music.sck-application-discovery.20261011`. The user completed its screen-permission setup. The native result used public shareable-content discovery, the frozen application profile, and source verification. No TCC database or private permission interface was used. The check does not establish the minimum sufficient consent for a later audio stream.

The protected query is used; no further query or capture is authorized. Cleanup verified the reviewed hashes, runtime files, and both app signatures. It archived the exact helper and profile, stopped the app, reset only its AudioCapture and ScreenCapture choices, unregistered both generated app copies, and removed them. A Launch Services dump contained no matching bundle identifier. No app, probe, or helper remained running. No reset targeted Hex or Ghostty.

The result, preparation/cleanup ledger, metadata preflight, archived helper, and profile remain in ignored `dist/application-discovery-evidence`. Discovery retained only fixed statuses and scalar counts. It saved no process identities, application catalog, window titles, audio, or video. The profile retains the reviewed installation paths and signing policy from offline preparation.

The separate application-capture preparation below follows this eligibility result. Discovery success provides no capture approval and does not clear the production gate.

## Prepare one application-audio availability probe

This local preparation requires the archived profile from the successful application-discovery check. The builder pins its exact SHA-256 digest. A missing or changed profile stops preparation; the builder does not refresh it from the installed app.

Build the new helper and unregistered app without launching either:

```sh
bun packages/music-core/prototypes/sck-audio/build-harness.ts --application-capture
```

This creates `dist/sck-application-capture-helper` and `dist/Kaset SCK Application Capture.app`. The app uses bundle ID `dev.naxo.music.sck-application-capture.20261011`. The helper has a separate signing identifier, profile path, and attempt directory. Historical discovery artifacts stay unchanged. An existing capture attempt marker prevents a rebuild.

The native mode accepts only its fixed catalog, application preflight, capture, and synthetic-test commands. It includes the existing bounded sample ring, analyzer, PCM sink, and Start/Stop completion ownership. Its composition excludes the Core Audio process-tap implementation. The parent never represents this application target as a process-mode source and starts no daemon or installed plugin.

The metadata preflight pins exactly one application and one verified WebKit witness in memory. After the one-shot claim, capture revalidates both around discovery. It includes exactly that application, with no window exceptions, on the returned display with the lowest identifier. The filter's application and display membership must match. It verifies the selected display's identity and dimensions, and the default output device's object and persistent UID. Missing or changed metadata stops the attempt. This route check does not establish the rendering process's physical output path.

Before Start, before accepting each fresh feature, and after Stop, the helper rechecks the pinned profile, application, witness, and environment. It enables 48 kHz stereo audio, disables microphone capture, and registers only an audio output. No screen sample, recording output, PCM file, or feature array is delivered or saved.

The native hard deadline is 15 seconds from helper startup, including discovery, Start, collection, and cleanup. Collection ends after ten seconds or one second before that deadline, whichever comes first. Start completion, any late successful Start, Stop, and output removal must settle before a summary is returned. Native cleanup failure uses exit 70; only the supported consent error after clean teardown uses exit 77. Forced termination cannot produce a checked result.

The parent has a twenty-second operation timeout covering metadata and capture. Its existing physical-exit cleanup allows one second after SIGTERM and one second after SIGKILL. The app terminates a stuck runner after 22 seconds and kills it after 24. These outer limits do not extend the native capture deadline. Permission setup starts no helper, and the attempt marker survives app restarts. A metadata failure before the claim can re-enable the button; a claimed capture cannot retry automatically.

The helper returns one bounded summary after teardown. It retains fresh, distinct measurement count `frames`, count `signalFrames` with maximum stereo RMS at least `1e-4`, `peakRms`, and `sampleSpanMs`. Samples older than 500 ms, repeated callbacks, and non-increasing timestamps cannot count. The capture sink rejects non-finite PCM before the shared ring. Unsupported or non-finite levels fail validation. The parent projects fixed fields, rejects inconsistent counts, and records one of these availability outcomes:

- `signal-observed`: at least three measured frames, three signal frames, and 500 ms of sample span.
- `measured-silence`: enough frames and span, with all measured RMS values exactly zero.
- `inconclusive`: insufficient frames, span, or signal. The result includes a fixed reason.

Every checked summary carries `isolationEstablished: false`. Energy in this filtered stream alone cannot establish its origin or exclude unrelated audio. Silence cannot establish a permission failure. The [isolation protocol](ISOLATION-PROTOCOL.md) separates this first availability check from later controlled reference captures. Those later stages remain a draft with unverified controls and need separate implementation, review, and approval.

Run the ten new native checks without live capture or discovery:

```sh
bun packages/music-core/prototypes/sck-audio/check-application-capture-native.ts
```

They cover profile and identity policy, discovery ordering, sample freshness and aggregation, exact filter membership, environment changes, late Start cleanup, cleanup precedence, synthetic interleaved/planar tone and silence, native denial, and rejected cross-mode commands. The complete forty-test prototype suite also checks the parent boundaries, one-shot claims, malformed summaries, cancellation, native exits 70/77, and import safety for the capture stage.

The app was registered and opened for the separately approved availability probe below. It was stopped and removed afterward, and its permission choices were reset. The probe used user-controlled Kaset playback and saved only the bounded summary in ignored `dist/application-capture-evidence`. It did not exercise the later reference-capture campaign or clear the production gate.

## Application capture result, 2026-10-11 UTC

One approved availability probe ran from 15:15:48.028 to 15:16:02.099 UTC, completing in 14.071 seconds. The user confirmed that Kaset was playing during the probe. That confirmation is context; no track identity or playback-state history was recorded.

| Check                                                 | Result                                |
| ----------------------------------------------------- | ------------------------------------- |
| Matching pinned Kaset applications                    | 1                                     |
| Profile, application, witness, and environment checks | Passed throughout                     |
| Stream Start                                          | Completed                             |
| Fresh measured frames                                 | 28                                    |
| Frames at or above RMS `1e-4`                         | 28                                    |
| Peak stereo-channel RMS                               | 0.2823674976825714                    |
| Measured sample span                                  | 9,160 ms                              |
| Stream Stop and output removal                        | Joined cleanly                        |
| Availability                                          | `signal-observed` / `measured-energy` |
| Native diagnostics                                    | None                                  |
| Isolation established                                 | No                                    |

The result meets the predeclared minimum of three measured frames, three signal frames, and 500 ms of sample span. It establishes measured signal availability in the verified Kaset application filter for this Mac, build, and configuration. It does not independently establish the signal's origin or exclude unrelated application audio. The controlled reference and isolation cases have not run.

The native helper registered only audio output. It saved no PCM, feature arrays, screen samples, or microphone samples. The parent returned the checked summary after physical helper exit and clean process cleanup. This successful path does not establish initial-denial behavior, active revocation, minimum sufficient consent, other OS versions, or full daemon/sidebar integration for the application target.

The approved test app used bundle ID `dev.naxo.music.sck-application-capture.20261011`. Cleanup verified the reviewed helper, profile, launcher, plist, runtime files, native sources, and signatures. It archived the exact helper and profile, stopped the app, reset only its AudioCapture and ScreenCapture choices, unregistered both generated app copies, and removed them. A Launch Services dump contained no matching bundle identifier. No app, probe, or helper remained running. No reset targeted Hex or Ghostty.

The single approved capture is used. The result, user-reported playback context, preparation/cleanup ledger, metadata preflight, archived helper, and profile remain in ignored `dist/application-capture-evidence`. No further capture or reference stream is authorized. Controlled isolation evidence remains the next investigation stage, and production capture remains unavailable.

## Prepare the unrelated source without playback

The [controlled-source research](CONTROLLED-SOURCE-RESEARCH.md) found no supported direct local-tone route in Kaset's matching upstream version. Existing uploads and remote YouTube media remain possible routes, but no suitable controlled asset has been identified. The full simultaneous protocol remains a draft. A narrower Safari-only exclusion check with Kaset silent could answer one part of the isolation question after separate preparation and review.

Build the local Safari tone page from the repository root:

```sh
bun packages/music-core/prototypes/sck-audio/browser/build.ts
```

This writes `safari-tone.html`, `offline-tone-check.html`, and `hashes.json` into this prototype's ignored `dist/controlled-sources`. The command bundles local source only. It opens no browser, starts no playback or native helper, and changes no permission or registration. Building again replaces these generated files; preserve any approved artifact and its hash before rebuilding.

The source page waits for **Start once**. It schedules a 2113 Hz sine at 0.1 peak amplitude, with identical stereo channels and a 48 kHz requested sample rate. A monotonic check rejects startup after fifteen elapsed seconds. Earlier startup uses only the remaining duration, capped at fifteen audio seconds. The audio clock stops the oscillator independently of JavaScript timers. A wall timer requests cleanup fifteen seconds after the click; browser scheduling can delay that callback. This page does not provide a hard wall-clock deadline. Future captures still need their native watchdog.

**Stop**, leaving or hiding the tab, and audio interruption request immediate graph disconnection. These handlers also depend on browser scheduling. The page permits one start per load. A reload is not another approved live attempt. Keep the page visible during any later approved playback.

The self-contained page uses inline hashed scripts and styles. Its content policy blocks external connections and resource loads. It sends no network requests and uses no microphone, recording, or capture API. Its status describes playback lifecycle only; it supplies no independent capture reference.

Run the source's type check and eight offline lifecycle regressions:

```sh
bunx tsc --noEmit -p packages/music-core/prototypes/sck-audio/browser/tsconfig.json
bun test packages/music-core/prototypes/sck-audio/browser/page.test.ts
```

The regressions reject automatic or repeated playback, a late resume before timer delivery, hidden/closed page continuation, audio interruption, and hidden startup or cleanup failure. They verify that startup time reduces the scheduled tone duration. They use fake contexts and play no sound. The separate browser fixture renders the same graph through [OfflineAudioContext](https://www.w3.org/TR/2021/REC-webaudio-20210617/#OfflineAudioContext), which produces an in-memory buffer without realtime output. It checks the fixed frequency's power, amplitude, identical channels, and zero output after fifteen audio seconds. It discards the buffer and reports only aggregate check results in the page.

Offline verification used Chrome 155.0.8059.40 with a temporary dedicated profile because the DevTools connector's profile was locked. The rendered graph measured peak `0.10000000149011612`, mean power `0.004999998109751191`, and marker purity `0.9999991658455091`. Channel difference and post-fifteen-second peak were zero. The source page stayed idle on load. Its idle controls and layout were inspected in a browser screenshot. Both pages produced zero console errors or warnings and zero external requests. The browser exited, and its temporary profile was removed.

The exact generated pages, hashes, screenshot, and aggregate browser verification remain in ignored `dist/controlled-sources`. Installed Safari playback, source ownership, route observation, common-clock analysis, and simultaneous reference streams remain unverified. No live capture, audible playback, permission reset, or app registration occurred during this preparation. This work creates no live allowance and does not clear the production gate.

## Prepare the Safari reference without capture

The [Safari exclusion contract](SAFARI-EXCLUSION.md) defines a smaller question: whether the Kaset application stream excludes a measured Safari marker while Kaset is paused. The full simultaneous isolation protocol remains separate. This preparation creates no live allowance.

Use this prototype checkout on the preparation Mac, with the archived successful Kaset discovery profile and the reviewed tone page already present. Build the isolated app from the repository root:

```sh
bun packages/music-core/prototypes/sck-audio/build-harness.ts --safari-exclusion
```

This creates `dist/Kaset Safari Exclusion.app` with bundle ID `dev.naxo.music.sck-safari-exclusion.20261011`. It creates a separately signed helper, a fixed Kaset profile copy, and a separately prepared Safari profile. Preparation selects the helper's native signing architecture explicitly. It validates Safari's disk code and freezes its canonical paths, Apple requirement, absent Team Identifier, and architecture-specific CDHash. Both profile digests are compiled into the helper. Kaset keeps its existing nonempty-team policy. The builder registers or opens no app, queries no shareable content, starts no stream, and changes no permission.

The native mode exposes only its fixed catalog, two application preflights, paired capture, and synthetic commands. It rejects the earlier capture and discovery flags. The parent verifies the signed helper before metadata and again before claiming the attempt. Three metadata commands pin one Kaset application, its existing WebKit witness, and one Safari application in memory. The reviewed tone page's exact hash must match before the atomic attempt claim. Missing metadata or a changed page cannot start protected discovery. An existing attempt marker blocks another run or rebuild.

After a later approval, the app's permission action starts no helper. The user pauses Kaset, starts the exact reviewed Safari page, keeps that tab visible, and promptly clicks **exclude** once. No playback command comes from this runner. It separately includes the pinned Kaset and Safari applications on the same selected display. It registers only audio outputs, requests 48 kHz stereo, and disables microphone capture. It creates no Core Audio tap, global mix, screen output, recording output, or fallback selection.

Both Start completions remain owned. After both succeed, one host-clock anchor fixes two seconds of warmup and sixty 100 ms evaluation windows. Each stream's presentation timestamps convert through its own unchanged synchronization clock. Complete 4,800-frame stereo windows must align to the same grid. Missing, duplicate, overlapping, stale, future, or discontinuous samples cannot become measured silence. The first admitted PCM format is pinned; a later layout or format change fails the operation. Identity, profile, display, and default-output consistency checks continue while measurements are accepted and after teardown.

The bounded analyzer retains one partial PCM window per stream. It computes a periodic Hann transform over bins 209–214, within the declared Safari band. It averages channel powers separately, so opposite channels cannot cancel. The independent reference must meet the fixed marker-power and spectral-purity thresholds in every paired window. Only aggregate powers and counts leave the helper. PCM, spectra, window arrays, identities, device lists, and arbitrary errors are not saved.

A clean result reports `passed` / `paused-target-exclusion`, `failed` / `target-energy-limit`, or `inconclusive` with a fixed coverage, control, or clipping reason. Exceeding a target threshold does not establish its audio's origin. Every result keeps `isolationEstablished: false`. A passing paused-target case would not establish Kaset admission, simultaneous isolation, permission behavior, or production readiness.

Both sinks are fenced before teardown. Any late successful Start receives Stop, and both Stop operations and output removals must join. Cleanup failure takes precedence over measurement and permission outcomes. Native exit 70 denotes failed cleanup; only the supported consent error after clean teardown uses exit 77. The native hard deadline is fifteen seconds from helper startup, including discovery and teardown. Collection ends by one second before that deadline. The parent has a twenty-second operation timeout; the app terminates a stuck runner at 22 seconds and kills it at 24. These outer limits do not extend the native capture allowance.

Run the nineteen native synthetic checks without discovery or capture:

```sh
bun packages/music-core/prototypes/sck-audio/check-safari-exclusion-native.ts
```

They cover both signing policies, exact filters, native clock arithmetic, contiguous sample coverage, Hann power normalization, tone/silence/opposite channels, non-finite samples, changed PCM layout, positive-control loss, marked and unmarked target energy, partial registration, late Start, cancellation during Stop, cleanup precedence, denial, and rejected cross-mode flags. The shared PCM checks also preserve the older sink's non-strict default. They construct no stream and query no shareable content.

Check the actual disk-code selector against an explicit native-architecture reference:

```sh
bun packages/music-core/prototypes/sck-audio/check-application-architecture.ts
```

This macOS check reads the installed Kaset and Safari signatures. It compiles the actual selector into a temporary program. It performs strict disk validation and compares each selected CDHash with the explicitly selected native slice. It queries no running process or protected content and starts no stream. The temporary program is removed afterward. This check is separate from the synthetic checks above.

The complete offline suite has fifty-six tests, including the eight browser tests. Run it with `bun test packages/music-core/prototypes/sck-audio`. Check the prototype and browser TypeScript projects separately, then run workspace lint. Installed Safari playback, actual dual-stream timing, exceptional callback ordering, and the measured exclusion case remain untested.

The original build and nineteen native checks passed. The fifty-six tests, prototype/browser type checks, workspace lint, core/plugin type checks, and package-content checks passed. Standards and Spec reviews resolved their two P3 findings; a separate clock/analysis/lifecycle review found no issue. The original metadata-only preflight returned unavailable while Safari was closed. No attempt was claimed during that preparation.

### Safari metadata failure on 2026-10-11

After separate approval, the isolated app was registered and opened. Only its AudioCapture and ScreenCapture permission choices were reset. The reviewed Safari page opened idle. The three-command metadata preflight then returned unavailable before claiming an attempt or requesting protected discovery. Safari was running, and its paths, signed identifier, and absent Team Identifier matched. Its running CDHash differed from the profile prepared with Security's default architecture selection.

A read-only diagnostic verified that explicit `arm64` selection matched running Safari. The actual-selector regression above failed with `native-architecture-mismatch` before the fix. It passed for Kaset and Safari after the selector began passing `kSecCodeAttributeArchitecture` to `SecStaticCodeCreateWithPathAndAttributes`. The rebuilt helper's three-command metadata preflight reached eligibility, then deliberately stopped before the attempt claim. It ran no protected command and returned no measured exclusion verdict. Kaset's archived profile stayed unchanged.

Cleanup verified the original hashes and strict signatures, stopped the isolated app, reset only its two permission choices, unregistered both generated app copies, and removed them. A Launch Services dump contained no matching bundle identifier. No owned app, probe, or helper remained running. No reset targeted Hex or Ghostty. The reviewed Safari tab was left open. The runner issued no playback command, protected discovery request, or capture request.

The replacement build passed strict signing checks and all nineteen native synthetic checks. The two disk-signature checks, fifty-six tests, prototype type check, workspace lint, core/plugin type checks, and package-content checks passed. The shared discovery source also passed a separate compile-only check. Standards and Spec reviews found no issue in this correction.

The original frozen plan, approval, helper/profile archives, and cleanup record remain in ignored `dist/safari-exclusion-evidence`. The replacement app was built and checked before registration. Its changed helper and Safari profile need a separately frozen replacement plan. The user's existing approval covers the unchanged app, application scopes, capture limits, and single unclaimed attempt. Record that continuation against the replacement plan; it adds no attempt. No protected attempt has been claimed, and no exclusion result exists. Production capture remains unavailable.

## Interpret the result

The original process-targeted native filter accepts exactly one ScreenCaptureKit application whose PID matches the verified Kaset WebKit process. It rechecks launch identity, running code, Core Audio identity, and mapped-cache ownership. Missing or duplicate matches stop acquisition. It never falls back to Kaset's main PID or a display-wide audio source.

The stream registers only an audio output and disables microphone capture. It still uses a display-bound application filter. No screen samples are delivered to this program; this does not prove that screen machinery or screen consent is absent.

Only `SCStreamErrorDomain.userDeclined` becomes native exit 77, after clean teardown. The adapter preserves that cause across concurrent pipe failures. Generic OS permission errors and generic stream stops remain setup failures. Silence remains measured zero. Cleanup errors supersede permission errors with abnormal exit 70.

The native cancellation path retains the Start completion, joins it, then joins Stop after any late success. An unresolved operation fails cleanup. A follow-up review verified those ordering and deadline corrections. Exceptional cancellation and late-Start callback ordering remain untested live.

The [authorization report](../../../../docs/music-audio-authorization-research.md#decision-and-proposed-experiment) defines the live acceptance criteria. Initial denial and responsible-app attribution have local evidence above. The exact-WebKit-process selector still lacks enumeration and capture evidence. Minimum sufficient consent, controlled audio-origin and isolation evidence, active revocation, and full TUI behavior remain open. If that exact process is absent, record that failure instead of broadening its filter.

Primary API contracts: [application filter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init%28display%3Aincluding%3Aexceptingwindows%3A%29), [stream-stop delegate](https://developer.apple.com/documentation/screencapturekit/scstreamdelegate/stream%28_%3Adidstopwitherror%3A%29), and [stream errors](https://developer.apple.com/documentation/screencapturekit/scstreamerror/code). The installed `SCStream.h`, `SCShareableContent.h`, and `CMSampleBuffer.h` supplied the compiled declarations.
