# Test Kaset application capture and isolation

This draft separates a first signal-availability check from later controlled isolation checks. The [application-targeting contract](APPLICATION-TARGETING.md) governs identity, scope, permission classification, and cleanup. The [completed application discovery](README.md#application-discovery-result-2026-10-11-utc) found one eligible Kaset application. It created no stream, so paused playback did not invalidate that result.

The [first availability probe](README.md#application-capture-result-2026-10-11-utc) completed under separate approval and observed measured signal. The user confirmed Kaset playback. Its one-attempt allowance is used, and its test app was cleaned up. The controlled stages remain blocked on the source, route, reference, and timing prerequisites below. This document grants no further live approval and reports no controlled isolation result.

## Freeze the experiment before approval

Use the installed macOS 27.0 SDK and the prototype's macOS 15.2 deployment target. Existing local evidence covers macOS 27.0.1 only. Freeze the OS build, helper and launcher hashes, source profiles, analyzer version, thresholds, route policy, attempt count, and deadlines in the reviewed plan. Changing one requires a revised plan before another live approval.

Keep the target application fixed at `com.sertacozercan.Kaset`, with its reviewed canonical installation and executable paths. Pin its designated requirement, Team Identifier, architecture-specific CDHash, PID, and launch identity. Retain the existing independently verified WebKit witness and Core Audio object identity in memory. Apply the contract's checks before discovery, after discovery, before Start, and while accepting samples. A changed proof ends the attempt; never select a replacement automatically.

Use exactly one including-applications filter for the verified Kaset application. Use the contract's fixed display selection and empty window exceptions. Reject missing, duplicate, or mismatched applications and displays. Never substitute a global mix, exclusion filter, different PID, or different application.

Apple describes application-level audio filtering in [Meet ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2022/10156/). The [including-applications initializer](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init%28display%3Aincluding%3Aexceptingwindows%3A%29) accepts application objects. Neither source specifies how Kaset's WebKit audio joins that application. Treat this grouping as an experiment, including when filter membership passes.

Configure 48 kHz stereo audio and disable microphone capture. Register only an audio output; register no screen or microphone output and no recording output. The display-bound filter still uses screen machinery. The SDK's `SCStream.h` declares `capturesAudio`, `sampleRate`, `channelCount`, and `captureMicrophone`; [stream configuration](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration) owns these settings.

Use one new isolated responsible-app identity, an atomic attempt marker, and a fixed evidence directory for each approved campaign. Permission setup must start no helper. Name that identity and its AudioCapture/ScreenCapture cleanup in the approval. Preserve Hex, Ghostty, and every unrelated app's permission choices. Use no permission database, private TCC API, or runtime log-based authorization decision.

## Stage 1: check signal availability

Request approval for one Kaset-only attempt with a 15-second native hard deadline. Ask the user to start ordinary playback in Kaset before clicking capture. The runner sends no playback commands and changes no installed Kaset code.

Collect for at most ten seconds after successful Start, or until one second before the native deadline, whichever comes first. Discovery, Start, Stop, and cleanup share the deadline. A forced exit or failed cleanup cannot produce a successful measurement.

After clean Stop, retain only these aggregate fields:

| Field          | Meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `frames`       | Fresh, distinct measured feature frames accepted while both source proofs remained valid. |
| `signalFrames` | Measured frames whose maximum left/right RMS is at least `1e-4` (-80 dBFS).               |
| `peakRms`      | Maximum measured left/right RMS across the attempt.                                       |
| `sampleSpanMs` | Elapsed sample time between the first and last fresh measured frames.                     |

Do not count repeated feature delivery as another measurement. Retain no feature array, PCM, application catalog, PID, path, window title, or arbitrary native error text in the result.

Declare the result using these rules before examining live data:

- **Signal available:** at least three measured frames, at least three signal frames, and a measured span of at least 500 ms.
- **Measured silence:** at least three measured frames spanning at least 500 ms, with every measured RMS exactly zero.
- **Inconclusive:** insufficient measurements or span, or measured energy that does not meet the signal criterion. State the fixed reason.
- **Failed attempt:** a supported permission error, invalid source proof, setup failure, abnormal deadline, or failed cleanup. Preserve the contract's error classification and cleanup precedence.

A signal-available result establishes energy in the filtered stream only. It does not establish the audio's origin, exclude another application, or prove isolation. Measured silence does not establish denial. A Play button, playback-state field, or listening impression cannot replace sample evidence.

Stop after this attempt. Prepare and review the controlled stages before requesting their separate approval.

## Prepare controlled sources and references

Keep ordinary music out of spectral isolation decisions. It can occupy both test bands and mask leakage.

The first-party [Kaset playback implementation](https://github.com/sozercan/kaset/blob/main/Sources/Kaset/Views/MiniPlayerWebView.swift) loads remote media in a persistent `WKWebView`. Its [URL handler](https://github.com/sozercan/kaset/blob/main/Sources/Kaset/Services/URLHandler.swift) describes media identifiers and supported remote routes. These sources do not establish a supported route for playing a local generated tone in the installed build. They also do not establish that the installed signed build matches current repository source.

Before the simultaneous test, identify user-controlled media that the unchanged installed Kaset can actually play. Freeze its asset hash, expected 997 Hz tone, identical stereo channels, 0.1 peak amplitude, and duration in the reviewed plan. Verify the route and asset against first-party source for the installed build. Do not inject script into Kaset, replace its media, upload content, publish an asset, or modify its installation under this protocol. If no supported controlled-media route exists, leave the simultaneous test blocked.

Use Safari as the proposed unrelated WebKit application, fixed at `com.apple.Safari`. Prepare a local, reviewed tone page with one user-operated Start control, a 2113 Hz sine, a fixed 0.1 peak amplitude, and a 15-second automatic stop. The page must request no microphone or capture permission and make no network request. Apple's [AudioContext.createOscillator reference](https://developer.apple.com/documentation/webkitjs/audiocontext/1631076-createoscillator) establishes the oscillator API. It does not verify this page or the installed Safari's playback. The page and its exact-byte hash still require implementation and offline review.

Pin Safari's canonical bundle and executable paths, signed identifier, designated requirement, Team Identifier, architecture-specific CDHash, PID, and launch identity through public Security APIs. Require exactly one running candidate. Close unrelated Safari audio and tabs with the user's approval. The reference scope covers audio assigned to the entire pinned Safari application, not one tab. Reject Safari Technology Preview, another browser, or a changed process.

Plan the following independent capture boundaries explicitly:

| Boundary         | Fixed scope                                                                              | Purpose                                                            |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Target           | ScreenCaptureKit, pinned Kaset application only                                          | Measure the proposed backend.                                      |
| Safari reference | A separate ScreenCaptureKit stream, pinned Safari application only                       | Prove the unrelated marker exists during every exclusion window.   |
| Kaset reference  | A separate process-scoped Core Audio tap, the already verified Kaset WebKit witness only | Prove Kaset's expected marker exists during the simultaneous test. |

The two references are proposed controls, not implemented capabilities. The existing process-tap approach does not provide a reliable denial signal; reference silence must invalidate a control. A positive expected marker may support a control only after its identity, route, analyzer, and timing checks pass. Sharing identity checks does not make the target stream an independent reference for itself.

The Safari reference needs additional explicit capture scope and approval. The Kaset reference also needs explicit approval for a second capture path. Describe the simultaneous stream count and summed capture duration, not only wall-clock duration. Neither reference may capture the system mix or silently expand its application/process scope.

## Verify the fixed output route

Select one local physical output device in the reviewed plan. Exclude AirPlay, Bluetooth, aggregate devices, virtual loopbacks, and automatic output switching from this first protocol. Do not change the route during an attempt.

Before Start and at each 100 ms analysis boundary, verify the system default output and each verified rendering process's output-device list. The SDK's `AudioHardware.h` defines [kAudioProcessPropertyDevices](https://developer.apple.com/documentation/coreaudio/kaudioprocesspropertydevices) as the devices used by that process, selected by input/output scope. It also defines [kAudioHardwarePropertyDefaultOutputDevice](https://developer.apple.com/documentation/coreaudio/kaudiohardwarepropertydefaultoutputdevice). Bind object identifiers to the same reviewed device UID in memory. Require exactly that output device; reject missing, multiple, or changed devices. Metadata can check route consistency without sampling unrelated audio.

A Safari main-process identity does not identify its audio-rendering WebKit process. First prepare and review a public-API ownership proof for that process. A name, common WebKit executable, shared framework signature, or currently running output is insufficient. The Kaset cache witness cannot prove Safari ownership. Missing attribution blocks the route check.

Route metadata does not prove that a physical device emitted the expected sound. An application-scoped ScreenCaptureKit reference proves that its stream contains the marker, but Apple's cited contracts do not bind those samples to physical output. No verified independent physical-route observation is prepared here. Keep the required rendered-through-route conclusion inconclusive until a separately reviewed method closes this gap. Do not add a microphone or global loopback as an implicit workaround.

Retain only route-check counts and fixed pass/change/unavailable outcomes. Keep device IDs, UIDs, process identities, and complete device lists in memory. A route change ends the attempt and invalidates its exclusion windows; never adapt the route automatically.

## Freeze numerical analysis and timing

These values specify the later controlled analyzer. They do not describe the Stage 1 implementation and have no live result.

Process 48 kHz stereo samples in fixed, non-overlapping 100 ms windows. Average channel powers without summing channels first. Use a Hann-windowed transform with power normalization verified against synthetic fixtures. Define total energy `E` as mean squared sample amplitude across both channels. Define band energies `K` over 967–1027 Hz and `S` over 2083–2143 Hz. Express power in dBFS as `10 * log10(E)`, with a fixed reporting floor of `1e-20`.

| Check                            | Predeclared threshold                                                           |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Reference marker present         | Its marker-band energy is at least `1e-4` (-40 dBFS) in every evaluated window. |
| Reference marker purity          | Marker-band energy is at least 95% of total energy.                             |
| Reference's other marker band    | At most `1e-8` (-80 dBFS).                                                      |
| Both-silent baseline             | Total and each marker-band energy are at most `1e-10` (-100 dBFS).              |
| Excluded Safari marker in target | `S_target <= max(1e-8, 1e-4 * S_reference)` in every evaluated window.          |
| Expected Kaset marker in target  | `K_target >= 1e-4`, and `0.25 <= K_target / K_reference <= 4`.                  |
| Clipping                         | No sample reaches absolute amplitude 0.99.                                      |

The leakage rule requires at least 40 dB energy attenuation above its absolute floor. The Kaset ratio allows approximately 6 dB gain variation. These are proposed experimental criteria, not Apple guarantees or calibrated noise limits. Reject contaminated or weak reference signals instead of relaxing thresholds after a run.

Use sample presentation timestamps, never callback arrival times or manually reported button-click times. Each `SCStream` exposes a [synchronization clock](https://developer.apple.com/documentation/screencapturekit/scstream/synchronizationclock). The SDK's `CMSync.h` defines [CMSyncConvertTime](https://developer.apple.com/documentation/coremedia/cmsyncconverttime%28_%3Afrom%3Ato%3A%29) and [CMClockGetHostTimeClock](https://developer.apple.com/documentation/coremedia/cmclockgethosttimeclock%28%29) for clock conversion. Convert sample timestamps to one host clock before pairing windows. The Core Audio reference must supply a validated mapping to that same clock.

Start all approved streams before defining the common observation start. Set that start to the latest first valid sample timestamp after conversion to host time. Discard two seconds of warm-up. Evaluate the next six seconds as exactly 60 aligned 100 ms windows. Reserve remaining time for clean Stop within the 15-second hard deadline. If startup or clock conversion leaves less than eight seconds of common samples, declare insufficient coverage. Do not extend an attempt or retry automatically.

Require complete sample coverage in all streams needed by each case, with no missing or duplicate sample interval. Require finite timestamps, monotonic progression, and clock-alignment uncertainty at most 5 ms, established before the live campaign. An invalid clock, unavailable conversion, discontinuity, or incomplete window makes the entire case inconclusive. Do not remove inconvenient windows after observing their energies.

Every window claiming exclusion of active Safari audio needs the Safari marker's simultaneous positive reference in that exact host-time interval. An earlier calibration, a later control, a Play state, and an output-running flag cannot validate it. The simultaneous case also needs the Kaset reference marker in every evaluated window. A target-only measurement cannot satisfy either control.

## Run the controlled cases after a separate approval

Request approval only after all blocked prerequisites have verified implementations. Freeze this sequence, four attempts, and no automatic retries. Each attempt has a 15-second hard deadline. Playback remains user-controlled and must reach the requested state before capture starts. Do not make playback transitions inside evaluated windows.

| Attempt | Playback state                   | Capture scopes             | Required evidence                                                                                 |
| ------- | -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| 1       | Both controlled sources silent   | Target and both references | All 60 windows meet the baseline and route checks.                                                |
| 2       | Kaset marker only                | Target and both references | Kaset reference stays positive; target admits K; Safari reference stays below baseline.           |
| 3       | Safari marker only; Kaset silent | Target and both references | Safari reference stays positive; target rejects S and meets the total-energy leakage limit below. |
| 4       | Both markers together            | Target and both references | Both references stay positive; target admits K and rejects S in every window.                     |

For attempt 3, require `E_target <= max(1e-10, 1e-4 * E_Safari_reference)` in every evaluated window. This limits unmarked leakage as well as the Safari marker.

This campaign has at most 60 seconds of wall-clock capture and 180 stream-seconds across three simultaneous boundaries. Stage 1 is a separate one-stream attempt and allowance. Explicit approval must cover the reference sources, playback setup, isolated app registration, scoped permission changes, and cleanup. Existing discovery allowances are used and cannot cover these attempts.

Treat the both-silent case as a noise and implementation check, not proof that either source could render. Its later positive cases supply that evidence. Treat any unexpected positive reference in a supposedly silent source as contamination. Preserve the failed outcome and stop the campaign before broader conclusions.

## Classify and retain the result

Report **pass** only when every case, every aligned window, all independent positive controls, the verified route observation, source proofs, and clean teardown pass. Describe the result as isolation within the declared leakage threshold for the tested build and configuration. Do not claim universal exclusion or zero leakage.

Report **fail** when a valid positive control establishes the expected source and a valid target window violates its admission or exclusion threshold. Also report fixed source/setup/permission/cleanup failures without turning missing controls into evidence of leakage. A cleanup failure supersedes every candidate pass.

Report **inconclusive** when controlled media, ownership, route observation, clock mapping, coverage, or positive controls are missing. Name the reason. Zero target energy with a missing reference is inconclusive; it cannot prove exclusion. A filtered signal without the independent controls remains availability evidence only.

Retain at most one bounded record per case: total/valid window counts, aggregate energy sums and maxima, threshold-violation counts, identity/route/control checkpoint outcomes, timing coverage, and the verdict. Cap the campaign at four case records. Keep samples and per-window values only for the current computation, then discard them. Save no PCM, feature arrays, spectra, application catalog, process identities, device lists, or arbitrary errors.

After the campaign, stop and join every stream and helper. Archive reviewed artifact hashes and sanitized aggregate results. Reset only the specifically approved isolated app's permission services, unregister and remove its generated app copies, and verify no campaign process remains. Preserve the spent attempt markers and budget ledger.

Initial denial, active revocation, process restart, helper updates, distribution, other OS versions, and full daemon/sidebar behavior remain separate acceptance work. A passing isolation campaign alone does not clear the production release gate.

The current blockers are controlled Kaset media, reviewed Safari ownership and tone playback, independent references, a validated physical-route observation, and common-clock analysis. No controlled case has run. Resolve these before presenting this draft as a runnable isolation procedure.
