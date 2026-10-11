# Safari captured-stream exclusion contract

This reference defines one narrower experiment: Kaset remains paused while Safari plays the fixed unrelated marker. Two separate ScreenCaptureKit streams measure the pinned Kaset application and the pinned Safari application. A pass would establish exclusion within these captured digital streams for the tested build and configuration. It would establish neither acoustic output nor full isolation during Kaset playback.

This contract has no measured exclusion result. The first approved setup stopped at Safari's metadata check and was cleaned up. Freeze the corrected helper and profile before resuming the same approved scope and unclaimed attempt. The [application-targeting contract](APPLICATION-TARGETING.md) still governs Kaset identity, permission classification, cleanup, and the production gate. The [four-case isolation draft](ISOLATION-PROTOCOL.md) remains unchanged, including its stronger physical-route prerequisites.

## Scope and controls

The target includes exactly the verified `com.sertacozercan.Kaset` application. The independent reference includes exactly the verified `com.apple.Safari` application. Each uses its own including-applications filter, with no window exceptions, on the same pinned display. Check exact application and display membership. Never replace either application, widen a filter, or substitute a system mix.

Apple's [including-applications initializer](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init%28display%3Aincluding%3Aexceptingwindows%3A%29) supplies this boundary. Application membership does not itself prove audio attribution. The two streams share ScreenCaptureKit, so the reference is an independent capture selection, not an independent framework implementation.

The user pauses Kaset and starts the [prepared Safari page](README.md#prepare-the-unrelated-source-without-playback). Freeze that page's exact-byte hash before approval. It generates a 2113 Hz sine at 0.1 peak amplitude in identical stereo channels, for at most fifteen audio seconds. Browser scheduling provides no hard wall-clock playback bound. Close other Safari audio only with the user's approval. The reference covers Safari as an application, not a particular tab.

Enable 48 kHz stereo capture and disable microphone capture. Register only audio outputs. Create no screen output, recording output, Core Audio tap, or Kaset test marker. Retain PCM only in bounded memory until analysis finishes, then discard it.

## Pinned Safari identity

Require exactly one running Safari candidate. Pin its canonical bundle and executable paths, signed identifier, designated requirement, architecture-specific CDHash, PID, and launch identity. Validate both on-disk and running code through public Security APIs. Recheck before and after discovery, before Start, while accepting samples, and after Stop. Missing or changed proof ends the attempt without selecting a replacement.

Read-only inspection on the preparation Mac resolved `/Applications/Safari.app` to `/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app`. Its signature reports `com.apple.Safari`, designated requirement `identifier "com.apple.Safari" and anchor apple`, and no Team Identifier. Subsequent build-only profile preparation passed strict on-disk validation outside the command sandbox. This does not establish running-app validation or capture eligibility.

Select the helper's native signing architecture explicitly with [`SecStaticCodeCreateWithPathAndAttributes`](https://developer.apple.com/documentation/security/secstaticcodecreatewithpathandattributes%28_%3A_%3A_%3A_%3A%29) and `kSecCodeAttributeArchitecture`. The installed SDK documents this attribute as the requested Mach-O architecture. On this Mac, default selection produced a valid disk signature whose CDHash differed from running Safari. Explicit `arm64` selection matched running code. The [disk-signature regression](README.md#prepare-the-safari-reference-without-capture) failed before the selector fix and passed afterward. The replacement helper also passed its three read-only metadata checks. These checks establish metadata eligibility only; they create no stream or capture approval.

The Safari profile must pin an absent Team Identifier explicitly. It must still require the reviewed Apple requirement, exact canonical paths, and architecture-specific CDHash. A present or changed team value invalidates that profile. Do not weaken Kaset's existing nonempty-team policy. Apple's [code-signing guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html) defines `anchor apple`; [SecCodeCopyGuestWithAttributes](https://developer.apple.com/documentation/security/seccodecopyguestwithattributes%28_%3A_%3A_%3A_%3A%29) identifies running code using public guest attributes.

The captured-stream claim needs no identification of Safari's WebKit GPU process. This is a design decision: the reference measures the marker in the explicitly pinned Safari application selection. It makes no process-ownership or physical-renderer claim. It does not satisfy the full draft's separate renderer-route proof.

## Clock contract

Apple documents [`SCStream.synchronizationClock`](https://developer.apple.com/documentation/screencapturekit/scstream/synchronizationclock) as the timebase for the stream's output sample buffers. The statement has no video-only restriction. [`SCStreamOutputType.audio`](https://developer.apple.com/documentation/screencapturekit/scstreamoutputtype/audio) identifies audio sample buffers. These contracts support converting each stream's audio presentation timestamps through its own synchronization clock.

Require a non-null, unchanged clock for each stream. Convert each audio buffer's [`presentationTimeStamp`](https://developer.apple.com/documentation/coremedia/cmsamplebuffer/presentationtimestamp) with [`CMSyncConvertTime(_:from:to:)`](https://developer.apple.com/documentation/coremedia/cmsyncconverttime%28_%3Afrom%3Ato%3A%29), using that stream's clock as the source and [`CMClockGetHostTimeClock()`](https://developer.apple.com/documentation/coremedia/cmclockgethosttimeclock%28%29) as the destination. The installed macOS 27.0 SDK's `CMSync.h` documents drift compensation and this host-clock conversion. `SCStream.h` exposes the nullable synchronization clock from macOS 13.

Validate numeric, finite, increasing timestamps and contiguous sample coverage. Reject invalid clocks, conversion results, timestamps, format changes, duplicates, overlaps, or gaps. Callback arrival times cannot establish sample alignment. Neither stream may subtract its own first timestamp and call the resulting timelines synchronized.

Set one host-clock anchor after both Start completions. After two seconds of warmup, evaluate sixty consecutive, non-overlapping 100 ms windows. Freeze the grid before examining energy. Require complete 4,800-frame stereo windows in both streams, with corresponding interval boundaries within 5 ms. This tolerance is an experiment limit, not an Apple accuracy guarantee. Missing silent-target callbacks remain missing data, not measured silence. No later successful segment may replace a failed window.

## Numerical acceptance

Use a Hann-windowed transform with synthetic-fixture-verified power normalization. Average channel powers without summing channels first. Define `E` as unwindowed mean squared stereo sample amplitude. Define `H` as the Hann-weighted squared amplitude normalized by the window's squared-weight sum. Define `S` as power in 2083–2143 Hz, using the same window normalization as `H`. Purity is `S / H`; using the same normalization keeps it a fraction of spectral energy. The fixed 4,800-point grid includes bins 209–214, at 2090–2140 Hz. Compare powers before display rounding. This runner retains linear powers only.

| Check                | Required value in every evaluated window                     |
| -------------------- | ------------------------------------------------------------ |
| Safari marker power  | `S_reference >= 1e-4`                                        |
| Safari marker purity | `S_reference / H_reference >= 0.95`                          |
| Target marker power  | `S_target <= max(1e-8, 1e-4 * S_reference)`                  |
| Target total power   | `E_target <= max(1e-10, 1e-4 * E_reference)`                 |
| Clipping             | No sample with absolute amplitude `>= 0.99` in either stream |

Non-finite samples or unsupported formats invalidate measurement. A separate silent-both baseline may check `E <= 1e-10`, but needs its own attempt and approval. It cannot replace a positive reference or change the thresholds after measurement.

## Environment, outcomes, and approval

Pin the default output device object and UID, plus display identity and dimensions. Recheck them during analysis. Missing or changed metadata ends the attempt. These are consistency checks; they do not establish a physical speaker path or acoustic emission. Restricting the conclusion to captured samples removes that prerequisite from this experiment only. This rationale is an inference about the question being tested, not an API isolation guarantee.

Missing clocks, complete coverage, valid reference energy, or valid identity/environment proof makes the exclusion claim inconclusive. Invalid PCM or clipping also prevents a pass. Clock, source, format, permission, and cleanup errors fail the operation without returning a measured verdict. A clean measurement with incomplete paired coverage, invalid reference windows, or clipping reports `inconclusive`. With all sixty windows and controls valid, any target threshold violation reports `failed` / `target-energy-limit`. That outcome does not establish the audio's origin: unexpected Kaset audio can also exceed the limit. A pass requires all sixty windows and clean teardown. It establishes this paused-Kaset/Safari-marker case only. It cannot establish Kaset-marker retention, simultaneous-source isolation, denial, revocation, or production readiness.

Retain only bounded scalar powers, counts, fixed checkpoint outcomes, and a fixed verdict/reason. Save no PCM, window arrays, process catalog, identities, device identifiers, or arbitrary native diagnostics. Cleanup failure supersedes measurement or permission outcomes.

A later approval must name the new responsible app, both application scopes, frozen profiles/page/helper/analyzer hashes, thresholds, deadlines, and scoped permission cleanup. One paired attempt allows at most fifteen native wall-clock seconds, including setup and teardown, and at most thirty summed stream-seconds. An optional baseline would make two separately approved attempts and at most sixty summed stream-seconds. Existing allowances are spent. No playback, registration, protected discovery, capture, or permission reset follows from this document.
