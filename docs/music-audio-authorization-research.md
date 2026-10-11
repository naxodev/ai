# System-audio authorization signals

No supported authorization query or revocation observer for the existing Core Audio process-tap path was found in the sources below. This is a bounded research result, not proof that no such API exists. Keep production capture unavailable until the [permission gate](music-audio-helper-distribution.md#release-gate-still-unmet) passes.

The source snapshot is repository revision `b5002714`, macOS 27.0.1 (`26A434`), and the installed macOS SDK 27.0. This investigation started no capture and changed no permissions or configuration.

## Core Audio contract

Apple requires `NSAudioCaptureUsageDescription` for process taps. Its sample documentation says the first recording from an aggregate device containing a tap triggers consent. An Apple engineer confirms that flow in the [system-audio permission discussion](https://developer.apple.com/forums/thread/771864). The later claim in that thread that no query API exists comes from a community participant, not Apple staff. [Apple tap sample documentation](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps).

The SDK's `AudioHardwareTapping.h` declares creation and destruction, with `OSStatus` results. Its tap property list exposes UID, description, and format. The Swift `AudioHardwareTap` interface wraps those properties. None exposes authorization state. Generic property listeners do not establish a consent observer without a documented consent property. `CATapDescription.bundleIDs` and `isProcessRestoreEnabled`, introduced in macOS 26, concern source selection and restoration. They do not supply authorization state. See the pinned SDK references below.

Apple's downloaded sample uses `AudioDeviceStart` and checks its result. Its listeners monitor device, composition, tap, and process properties. No explicit system-audio permission query or revocation observer was found in that source. [Apple sample archive](https://docs-assets.developer.apple.com/published/02fe64305fe7/CapturingSystemAudioWithCoreAudioTaps.zip).

`kAudioDevicePermissionsError` (`!hog`) describes an operation denied because the process lacks permission. The SDK does not promise this result for every system-audio denial. `kAudioHardwareIllegalOperationError` (`nope`) describes a failed operation, not a consent decision. A returned error can stop capture, but success cannot prove consent. The [isolated matrix](music-local-daemon-audio-evidence.md#isolated-permission-matrix-2026-10-10) already recorded denied requests that continued emitting zero-valued features. [Core Audio error reference](https://developer.apple.com/documentation/coreaudio/kaudiodevicepermissionserror).

The helper's `check(_:)` function maps nonzero `OSStatus` results to `setup`; cleanup errors use `cleanup-failed`. The native adapter maps other non-timeout helper exits to `setup`. Preserving a specific returned permission error could improve diagnostics, but cannot solve the observed successful-start denial. Neither zero samples nor missing callbacks establish permission failure. [Native helper](../packages/music-core/audio/native/MusicAudioHelper.swift), [native adapter](../packages/music-core/audio/native-helper.ts), [status requirements](music-audio-visualization-plan.md#independent-protocol-and-feature-stream).

## Similar APIs answer different questions

| API                                                | Documented scope                                              | Use for this process-tap gate                            |
| -------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `AVCaptureDevice.authorizationStatus(for: .audio)` | Camera and microphone capture devices                         | No documented system-audio status contract.              |
| `AVAudioApplication.shared.recordPermission`       | Audio application operations, including microphone permission | No documented process-tap status contract.               |
| `CGPreflightScreenCaptureAccess()`                 | Whether the current process has screen capture access         | Does not establish the separate system-audio-only grant. |
| ScreenCaptureKit `SCStreamError.userDeclined`      | Screen Recording consent failure                              | Candidate signal within a different capture backend.     |

Apple describes [AVFoundation authorization](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media) in terms of camera and microphone access. The [AVAudioApplication overview](https://developer.apple.com/documentation/avfaudio/avaudioapplication) names microphone permission. These contracts do not justify adding a microphone prompt to system-audio capture.

The SDK describes `CGPreflightScreenCaptureAccess()` as a screen-access check for the current process. It does not document a system-audio-only check or a query for another responsible app. Using it as the process-tap authorization signal would therefore add an unverified assumption. [Core Graphics reference](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess%28%29).

## ScreenCaptureKit is an untested alternative

ScreenCaptureKit provides application filters, audio output, and an asynchronous stream-stop delegate. Apple documents `userDeclined` (`-3801`) as a Screen Recording permission failure. `failedToStartAudioCapture` (`-3818`) and `systemStoppedStream` (`-3821`) do not, by themselves, establish denied permission. [Stream errors](https://developer.apple.com/documentation/screencapturekit/scstreamerror/code), [stream delegate](https://developer.apple.com/documentation/screencapturekit/scstreamdelegate).

Apple's 2022 introduction states that audio filtering operates at application level, and describes consent under Screen Recording. ScreenCaptureKit requires its own authorization evaluation; it is not a permission probe for an existing Core Audio tap. [Meet ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2022/10156/).

Apple's macOS 26 guide distinguishes screen-and-audio consent from audio-only consent. The minimum sufficient grant for the proposed `SCStream` and shareable-content configuration remains untested. No ScreenCaptureKit behavior was tested here, including audio output without screen delivery, Kaset WebKit attribution, isolation, responsible-app attribution, or active revocation. [Current permission categories](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/26/mac/26).

## Decision and proposed experiment

Keep the current production gate closed. Do not read TCC databases, call private TCC functions, parse system logs as a runtime authority, or infer consent from silence. The prior TCC logs remain diagnostic evidence, not a public application interface.

Two useful paths remain: seek Apple's supported process-tap authorization guidance with the existing denial reproducer, or evaluate ScreenCaptureKit in an isolated prototype. The prototype must first establish its required consent scope. It has not been implemented or run.

Before any live prototype, establish a filter that includes only verified Kaset ownership. Fail closed if WebKit audio cannot be tied to that application. Enable no microphone output and deliver no screen samples. Include no global-audio fallback. Keep the responsible app, signature, helper layout, and launch path fixed across the matrix.

The prototype must test through the daemon and sidebar, with these pass criteria:

- Decline the initial prompt: emit no features, never report `active`, and surface a confirmed permission failure.
- Grant consent: deliver measured Kaset features. Legitimate source silence remains zero energy without a permission error.
- Revoke consent during capture: stop feature delivery and clear `active` within a declared bound, with supported evidence for the permission failure.
- Verify the source filter excludes other apps. Ambiguous source attribution fails the experiment.

Define the consent-change detection bound before the live run; the current code has no such guarantee. Reuse existing teardown bounds after detection: the parent waits one second after `SIGTERM`, then one second after `SIGKILL`; the native stop watchdog allows 750 ms. Forced exit remains abnormal cleanup. A generic stream stop without confirmed denial fails the permission criterion. [Helper termination](../packages/music-core/audio/helper-process.ts), [native watchdog](../packages/music-core/audio/native/MusicAudioHelper.swift).

## Search scope and pinned evidence

The search covered Apple's tap documentation and sample, Core Audio reference, relevant Apple developer forum discussions, and the installed SDK's public CoreAudio headers and arm64e Swift interface. It also checked CoreGraphics, ScreenCaptureKit, AVFoundation, and AVFAudio public headers for candidate access APIs. Searches included authorization, permission, denial, revocation, capture access, and process taps. No private interfaces were used. This scope does not cover unpublished APIs, every Apple framework, or future SDKs.

`SDKROOT` below is `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk`. Header paths are relative to `SDKROOT/System/Library/Frameworks/`.

| Source                                                                          | Relevant locations                                                    | SHA-256                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `CoreAudio.framework/Versions/A/Headers/AudioHardwareTapping.h`                 | Lines 34–54: tap lifecycle and results                                | `aa337054d41d0a2293b91fa7a2ec2e1819d66ab7722c60ff9a482821a4ccd92e` |
| `CoreAudio.framework/Versions/A/Headers/AudioHardware.h`                        | Lines 1984–2023: tap properties                                       | `a699437248e079d9ebe47078ef3861492d8253fef1a6007e476031031d3535ca` |
| `CoreAudio.framework/Versions/A/Headers/AudioHardwareBase.h`                    | Lines 115–166: HAL errors                                             | `cbac54e8edb7ee99bf10c18a2db044e01c47645985b2f2824623f3f8371a7c4e` |
| `CoreAudio.framework/Versions/A/Headers/CATapDescription.h`                     | Full public description                                               | `6f13f17c25e80c52ef3e490fc1b2c236e37c6b4ab5506c8c9962fb2da34e4ca8` |
| `SDKROOT/usr/lib/swift/CoreAudio.swiftmodule/arm64e-apple-macos.swiftinterface` | Lines 13–95 and 674–687: system, listeners, and tap interface         | `f657d74a0a5593860d47f39b5d409fc6990408dbf0062bdc120bf9437c8b480a` |
| Apple sample ZIP linked above                                                   | `Model.swift`, `AudioTap.swift`, `AudioRecorder.mm`, and `Info.plist` | `46edc0114dd5ecb11fdfd1b87b1f57628be71988a460c5cb0b831a237a5fe657` |

Additional SDK contracts checked: `CoreGraphics.framework/Versions/A/Headers/CGWindow.h` lines 295–308; `ScreenCaptureKit.framework/Versions/A/Headers/SCError.h` lines 15–35; `SCStream.h` application filters, audio configuration, and stop delegate; `AVFAudio.framework/Versions/A/Headers/AVAudioApplication.h` lines 107–119; and `AVFoundation.framework/Versions/A/Headers/AVCaptureDevice.h` authorization methods.
