# Why Kaset application targeting needs a separate contract

The [discovery-only Kaset application path](README.md#application-discovery-result-2026-10-11-utc) found one verified application in a separately approved local check. It created no stream. A [separate bounded capture prototype](README.md#prepare-one-application-audio-availability-probe) is prepared but has not run. The production gate stays closed.

The [completed discovery check](README.md#discovery-only-result-2026-10-11-utc) found no ScreenCaptureKit application for a verified Kaset WebKit PID. Identity and cache attribution passed before and after discovery. Replacing that PID inside the current process source would change the approved scope.

The application target covers all audio that ScreenCaptureKit assigns to one verified Kaset application. It does not promise a single WebKit process, song, window, or tab. The experiment must state that scope before requesting live approval.

## What the API contract supports

Apple describes audio filtering at application level in [Meet ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2022/10156/). An [`SCRunningApplication.processID`](https://developer.apple.com/documentation/screencapturekit/scrunningapplication/processid) identifies the application process. The [including-applications filter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init%28display%3Aincluding%3Aexceptingwindows%3A%29) accepts application objects from shareable content.

These contracts support investigating an explicit application target. They do not establish how Kaset's WebKit GPU audio joins that target. A successful discovery or filter membership check would establish eligibility only. Measured capture and exclusion of unrelated audio would still need live evidence.

The existing [authorization decision](../../../../docs/music-audio-authorization-research.md#decision-and-proposed-experiment) continues to govern permission classification and release criteria.

## Two identities with different roles

The application identity determines the proposed filter. A separately verified WebKit identity supplies the existing local ownership witness. Neither identity substitutes for the other.

The application candidate comes from [`NSRunningApplication.runningApplications(withBundleIdentifier:)`](https://developer.apple.com/documentation/appkit/nsrunningapplication/runningapplications%28withbundleidentifier%3A%29), using the fixed identifier `com.sertacozercan.Kaset`. Require exactly one candidate before applying further selection rules. Names, window titles, current playback, and a caller-supplied PID cannot select the application.

The following fields define the proposed internal application proof. They are design notation, not a new public API or an implemented schema.

| Field               | Required check                                                                     | Purpose                                          |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| Scope               | Literal `kaset-application`                                                        | Prevent interpretation as process capture.       |
| Bundle identifier   | Fixed Kaset identifier in application metadata and signed code                     | Reject a display-name or metadata-only match.    |
| Process identifier  | Positive PID of the single candidate                                               | Match the returned ScreenCaptureKit application. |
| Launch identity     | Existing native process start-time identity                                        | Reject an exited or reused process.              |
| Executable identity | Canonical executable path and running-code CDHash                                  | Reject replacement or changed code.              |
| Bundle location     | Canonical path of the reviewed Kaset installation                                  | Reject another installed copy.                   |
| Signing policy      | Reviewed designated requirement, Team Identifier, and architecture-specific CDHash | Pin the exact local build for this experiment.   |

Public Security APIs must validate the running code against the reviewed policy. Reading signing fields alone does not validate them. Verify the on-disk bundle separately, and bind its executable to the running-code identity. Missing fields, failed validation, or inconsistent metadata make the candidate unavailable.

Read-only inspection of `/Applications/Kaset.app` found the expected signing identifier and a development signature. Strict bundle verification passed outside the command sandbox. The sandbox check returned `CSSMERR_TP_NOT_TRUSTED`; that result must remain a failure in that environment. No trust setting or signature was changed. A metadata-only preflight also verified the running application and WebKit witness. A process guard refused protected discovery, and no attempt was claimed.

Offline preparation must freeze the reviewed bundle location, signing requirement, Team Identifier, and CDHash in a bounded local profile. Compile that profile's digest into the dedicated signed helper. The helper must reject a changed profile. It must accept no command-line override for these fields. A Kaset update requires a new reviewed profile and invalidates the prepared experiment.

The WebKit witness reuses the existing verified Core Audio catalog and `kaset-cache-v1` attribution. Require exactly one witness, including paused candidates when checking ambiguity. Preserve its PID, launch identity, executable identity, and Core Audio object identity in memory. Cache attribution identifies the observed owner bundle; it does not prove ScreenCaptureKit audio grouping or a parent-child process relationship.

The application and witness proofs expire when either identity changes. No automatic restart, replacement-process selection, or profile refresh occurs during an attempt.

## A separate prototype boundary

The proposed application mode stays inside this prototype directory. It does not reuse `ResolvedCaptureSource.mode = "process"`, alter the shipped source schema, or replace the current exact-PID selector.

An application runner owns an internal proof containing `scope: "kaset-application"`, the application identity, and the WebKit witness. Only native verification can construct that proof. A client label, source token, successful metadata read, or permission preflight grants no capture authority.

The separate application helper exposes the fixed discovery command `--discover-kaset-application`, with fixed metadata and synthetic-test commands. Its process boundary rejects capture flags. It creates no filter, configuration, stream, sink, or sample buffers.

The runner uses a new isolated app identity and evidence directory. Build-only preparation must not register or launch the app. The app needs a separate permission button and a one-shot discovery button. Granting permission starts no discovery. An atomic attempt marker precedes the protected query and survives app restarts.

The runner reuses the existing discovery bounds: eight seconds for the parent operation, ten seconds for the native hard deadline, and app termination at ten seconds followed by forced termination at twelve. Cleanup failure or forced exit cannot produce checked evidence.

## Verification around discovery and capture

The proposed discovery sequence is:

1. Validate the fixed profile, the single running Kaset application, and the single WebKit witness.
2. Claim the attempt before invoking protected shareable-content discovery. Revalidate both identities and cache attribution immediately before the query.
3. Use the current discovery options: exclude desktop windows and include off-screen windows. Keep permission scope explicit.
4. Revalidate both identities and cache attribution immediately after discovery, before consuming its content.
5. Require exactly one returned application with the fixed bundle identifier. Require its PID to match the verified application identity. Reject absent, duplicate, or inconsistent matches.
6. Require at least one display. Return only fixed checkpoint results and bounded scalar counts.

The discovery result can report application match count, witness PID match count, and display count. A witness match count of zero remains a valid diagnostic result. Application eligibility requires exactly one verified application match. Counts must be finite nonnegative integers with the existing upper bound of 65,536. No returned application catalog, PID, path, window title, raw error text, audio, or video enters the result file.

Constructing a filter belongs to a later, separately reviewed capture mode. It must use `SCContentFilter(display:including:exceptingWindows:)` with exactly the verified application and an empty window-exception array. Choose one display by a fixed ordering of returned display identifiers. Assert one included application with the approved PID and bundle identifier, and one included display with the chosen identifier. Never substitute an exclusion filter or an empty application list.

Revalidate both identities and attribution before Start, before publishing each feature frame, and during the existing lease loop. A failed check fences feature delivery before teardown. A changed application, witness, profile, or selected display ends the attempt. Device changes never trigger a broader filter or a new selection. These are proposed requirements; no application-mode detection bound has been measured.

Reuse the existing bounded Start/Stop completion ownership and parent termination rules. Enable only the audio output and disable microphone capture. Deliver and retain no screen samples. The display-bound filter still uses screen machinery and may require screen consent.

Only the supported native consent error can establish permission failure. Silence remains measured zero. Generic stream failures remain setup failures. Cleanup failure takes precedence over every successful or permission outcome.

## Isolation evidence required before a backend decision

Filter membership alone cannot prove which audio the framework delivers. The application mode needs controlled positive and negative evidence after discovery succeeds and a capture mode passes review.

The later protocol must define signal levels, noise thresholds, timing windows, and failure bounds before any live approval. It needs distinguishable, user-controlled signals from Kaset and an unrelated WebKit application. It should retain only bounded aggregate energy in the chosen frequency bands, counts, and checkpoint outcomes. A listening impression or nonzero RMS cannot establish isolation.

Each signal needs an independent positive control. Every exclusion window must confirm that the unrelated source rendered its expected signal through the selected output route during that window. A Play button, `runningOutput` flag, or an earlier successful playback does not establish that fact. The protocol must specify how the control verifies the expected signal and aligns its timestamps with capture. Missing control evidence makes the window inconclusive. Any control that captures another source needs its own declared scope and approval; no global-audio capture is permitted.

The required cases are:

- Kaset alone: identify its expected signal in the measured features.
- Unrelated WebKit audio alone, with Kaset silent: confirm the unrelated signal through its independent control and establish its absence from capture.
- Both applications together: confirm both source signals independently, identify Kaset's signal, and reject the unrelated signal within the declared threshold.
- Kaset pause and resume: preserve measured silence without inferring a permission change.
- Kaset or witness exit, restart, or identity change: stop publishing features and require a new selection.
- Initial denial and active revocation: meet the existing permission criteria with supported evidence and declared bounds.

No capture case has run for application targeting. The [controlled protocol draft](ISOLATION-PROTOCOL.md) declares thresholds, controls, and unresolved prerequisites. Even a passing local protocol would establish only the tested build and configuration. Distribution, update behavior, other supported macOS versions, and full daemon/sidebar integration remain separate release work.

## Implementation order and review gates

The fixed application profile, native identity verifier, and fake-boundary selector tests are implemented. The tests reject duplicate applications, spoofed bundle metadata, wrong signing policy, changed executable code, PID reuse, and missing or ambiguous witnesses. Profile preparation validates the installed bundle on disk. The metadata preflight and protected discovery check verified the local running app against that policy. Application audio grouping remains untested.

The discovery-only runner and isolated build profile are also implemented. Offline tests check that changes before or after discovery prevent content use. They reject cross-mode commands and changed profiles, preserve cancellation and cleanup precedence, and prevent imports from starting native work. A launcher fixture verifies that granted or declined permission setup never launches a child. No protected discovery belongs in a test. The local check exercised screen-permission setup and the shareable-content callback. Audio-stream consent, denial, revocation, and stream callback lifecycle remain untested for this application target.

Both changes passed review. The separately approved application-discovery check found one verified main Kaset application and no application match for its WebKit witness PID. That query is used, and its test app was cleaned up. It establishes local discovery eligibility only.

The checked application match supports the separately prepared capture mode and controlled isolation protocol. Capture preparation needs another review before requesting specific live permission changes and bounded capture attempts. The prepared first probe reports availability only; it cannot claim isolation. No live query, capture, registration, permission reset, or playback change is authorized by this design.
