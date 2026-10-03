# Audio-reactive music visualization research

Research question: what must change for the music bars to follow real audio, with interchangeable visualization styles?

Research date: 2026-10-03. Baseline: macOS 26.6.2, Kaset 0.14.1, and repository revision `7884b19b`. This report covers the current implementation, native capture, permissions, distribution, signal transport, and selectable terminal visualization styles. It recommends a research prototype, not an approved implementation or verified capture integration.

## User preferences

- Capture the current music player only. Do not include notifications, calls, or other apps.
- Compare a bundled helper with external tools and recommend one.
- Support spectrum bars, an oscilloscope, mirrored spectrum bars, and stereo level meters.
- Use a responsive taller display, approximately 4–6 sidebar rows when space permits, with a one-row compact presentation.

These preferences were selected during the research discussion. Audio capture and OS permission changes have not been authorized or performed.

## Player-agnostic source selection

Kaset is the first difficult test case, not the only intended player. The capture service should separate source selection, capture, analysis, and presentation. None of the four visualization styles should depend on a Kaset-specific playback implementation.

Offer two external-player selectors:

- **Follow Now Playing:** use structured source metadata to identify the active application, then resolve its actual audio processes.
- **Choose an application:** persist an application identity, not a PID, and follow its process lifecycle independently of which app currently owns Now Playing.

An application with a documented PCM or analysis output can use a separate provider integration instead of OS capture. That is an optional source adapter, not a reason to require every player to expose the same private API.

The [terminal-player comparison](cli-audio-visualization-comparison.md) verifies existing examples: CLIAMP exports real spectrum through `visstream`/`spectrum.get`, and MPD can export a raw PCM FIFO. Prefer a cooperative feed when it supplies the selected style's data. CLIAMP's reviewed spectrum export is not a full waveform/stereo feature bundle; unsupported styles must remain explicit rather than fabricated.

The current provider already handles different apps through `media-control`, but its normalized `device.name` is only a display label. [Source normalization](../packages/music-core/system-media.ts) does not preserve the app bundle ID or audio process identity in `PlayerState`. A general capture implementation needs an explicit source-identity channel; it must not guess from a display name or reuse track IDs as process IDs.

Test native players and helper-process players separately. Kaset, Spotify, Apple Music, mpv, CLIAMP, and browser playback are candidate compatibility tests, not verified supported sources. The API does not establish a universal answer for protected audio.

For browsers, application-level capture can include multiple tabs or windows. "Selected application only" must not be advertised as "current song/tab only" without an independently verified narrower source. When the intended source is unresolved, show unavailable rather than capture every WebKit process or all system audio. [A6] [A7]

## Conclusion

Use **an opt-in Core Audio process-tap helper** as the first production candidate. It can capture rendered audio without a microphone or an installed loopback driver. Its actual API floor is **macOS 14.2**, not 14.4. On macOS 26, bundle-ID targeting and process restoration offer additional tools. Neither guarantees that targeting Kaset's main app includes its WebKit audio helpers. [A1] [A2] [A3] [A4] [H1]

The central risk is **source attribution and capture authorization**, not drawing bars or computing an FFT. Kaset 0.14.1 itself uses process taps for its equalizer. Its implementation targets WebKit GPU/WebContent processes rather than its main PID. This is strong implementation evidence for the capture route, but not verification that an external helper will identify those processes correctly. [O1]

Recommended order:

1. Prove unmuted capture of Kaset's actual audio process, with explicit permission, before integrating it into the daemon.
2. Prove isolation from another WebKit app, process restarts, and output-device changes.
3. Compute small signal features once and share them through the existing local daemon.
4. Treat visualization styles as consumers of those features, not separate capture sessions.

ScreenCaptureKit is a credible alternate backend, especially for macOS 13 support. It has an application-level audio-filter contract, but also screen-oriented setup and authorization. BlackHole or Loopback plus CAVA is an optional, user-configured comparison route, not a required installation. **CAVA 1.0.0 also supports native Core Audio taps**, so a loopback driver is no longer its only macOS route. [A5] [A6] [A7] [O4] [O5]

No audio capture, installation, permission change, or implementation was performed for this research.

## Can the player metadata supply the sound levels?

Not through this plugin's current metadata contract. [The track and player types](../packages/music-core/types.ts) carry identity, duration, playback position, state, and device metadata. [The session schemas](../packages/music-core/session/protocol.ts) contain no PCM samples, frequency spectrum, or stereo levels. The [media-control interface](https://github.com/ungive/media-control) exposes Now Playing metadata and playback commands, not an audio-analysis stream.

The existing [shared waveform engine](../packages/music-core/waveform.ts) explicitly says it does not analyze audio. It creates deterministic levels from a track seed and playback time. Its apparent beat rate is generated, not measured. Metadata can indicate which player to target and whether playback is paused; it cannot recover the sound's amplitude, frequencies, or waveform.

CLIAMP exposes a separate spectrum API, but no such API is established for Kaset in this research. This is an additional audio-analysis capability, not ordinary Now Playing metadata. Fetching BPM or a precomputed track analysis from a catalog would not prove what the player currently renders. It would also need track identification and playback alignment, which the earlier metadata gaps make unreliable.

## Four visualization styles

These are familiar visualization families, not a statistically established popularity ranking. They can share one audio source and analysis stream.

| Style               | What it shows                           | Required feature data                               | Terminal presentation                                                 |
| ------------------- | --------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| Spectrum bars       | Energy from low to high frequencies     | Log-frequency band magnitudes                       | Block-height columns with optional peak markers; recommended default. |
| Oscilloscope        | A short time-domain signal trace        | Bounded signed samples or time-bucket min/max pairs | Braille or block line plot; more useful with several rows.            |
| Mirrored spectrum   | Spectrum expanding around a center line | The same frequency magnitudes as spectrum bars      | Centered columns above and below the line; no second capture session. |
| Stereo level meters | Left/right RMS and sample peaks         | Per-channel level values                            | Two horizontal meters with peak hold and honest units.                |

The [Web Audio analysis model](https://webaudio.github.io/web-audio-api/#AnalyserNode) distinguishes time-domain samples from frequency data and describes windowing, FFT, smoothing, and decibel conversion. It is an explanatory signal-processing reference, not a proposal to access Kaset through a browser `AudioContext`. Spectrum magnitudes alone are insufficient for a faithful oscilloscope. Avoid simple waveform subsampling that can miss peaks or alias the signal; bound the waveform preview and test its reduction and display behavior.

The level-meter style may be named "VU" in the UI, but an RMS/peak display is not automatically a calibrated VU meter or an integrated LUFS loudness meter. Use sample-level/dBFS labeling unless calibrated meter behavior is deliberately implemented. Do not infer true peak or reliable BPM from those values.

Full [MilkDrop/projectM presets](https://github.com/projectM-visualizer/projectm) are a different scope. Their upstream library consumes PCM, analyzes beats/frequencies, and renders OpenGL shader presets. That pipeline and its licensing are much heavier than four terminal-native styles. Circular spectra, spectrograms, and beat pulses can be considered later, after source isolation and the simpler styles work.

## Fit with this repository

The [OpenCode waveform component](../packages/opencode-music-player/waveform.tsx) owns a local animation coordinator. It currently writes one row of block characters at approximately 21 updates/second for the hero variant and 16 for the smaller variant. Its `rows` property is not used, and both variants intentionally render one row. [The sidebar](../packages/opencode-music-player/ui.tsx) supplies 24 bars. A taller visualization needs an actual row budget and responsive rendering, not just another variant name.

[Pi](../packages/pi-music-dock/extensions/music-dock/waveform.ts) uses the same synthetic core engine through its own coordinator. Preserve its existing behavior unless that integration is explicitly included. Do not silently change the public synthetic engine into a capture-dependent API.

The existing [singleton session coordinator](../packages/music-core/session/coordinator.ts) owns playback, provider state, and the global command lane. Extend that ownership with a separate optional capture/analysis service, rather than starting a helper in every OpenCode window.

Proposed data flow:

```text
Current-player identity from metadata
  → verified audio-process selection
  → one unmuted native capture helper
  → native analysis worker: spectrum + waveform preview + stereo levels
  → bounded, source-generation-tagged feature frames
  → singleton local daemon, latest-frame fan-out
  → OpenCode style renderer at its allocated width/height
```

The current normalized provider type does not retain a process PID. Its raw [media metadata](../packages/music-core/system-media.ts) retains app bundle hints, but the audio-source identity needs explicit treatment. Track IDs are not process IDs or Core Audio object IDs. Keep capture identity separate from recording identity and invalidate old features when the target player changes.

This research does not define the final public protocol. The implementation should negotiate an optional visualization capability, preserve old clients, and keep signal frames independent of authoritative `PlayerState` revisions. Use finite frames and arrays, source generations, timestamps, and a conflating latest-frame path. A slow view should drop animation frames without delaying Next, Play, or permission/status updates.

Native analysis can use Apple's Accelerate/vDSP. Start with one feature bundle containing frequency bands, a small signed waveform preview, and left/right levels. This supports all four selected styles without restarting capture when the user switches style. Fixed analysis resolution can be reduced for a narrow terminal view; final sizes require measurement.

### Layout and switching

- Start with spectrum bars as the default, selected through a command palette action and a persistent preference.
- Offer all four styles through the same selector. A future keyboard shortcut should use the host's verified command API, not a guessed binding.
- Allocate approximately 4–6 rows only when the sidebar has room. At constrained height or width, use a compact one-row representation of the selected style or a documented meter fallback.
- Keep terminal-native block/Braille rendering as the baseline. Kitty graphics should not become mandatory for reactive bars.
- Separate capture controls from style controls. Switching style must not reprompt for consent, change audio routing, or spawn another helper.
- With capture off or unavailable, show an honest inactive state. If decorative animation remains available, label it explicitly as animation rather than pretending it follows sound.
- Pause, source loss, stale frames, and quiet audio must not cause synthetic energy. Allow a short measured decay, then stop needless redraws.

### Recommended development order

1. **Capture proof:** With explicit user approval, test player-only Kaset audio, privacy prompting, and isolation from another WebKit app. Compare Core Audio taps with ScreenCaptureKit if ownership cannot be established. Stop here if neither can meet the player-only requirement.
2. **Signal proof:** Use deterministic tones, silence, impulses, and asymmetric stereo fixtures. Verify bands, waveform reduction, and per-channel levels independently of track metadata.
3. **Shared integration:** Add the optional helper lifecycle, bounded feature stream, cancellation, and old-client compatibility. Playback must remain usable without audio permission.
4. **Presentation:** Add the responsive spectrum, then oscilloscope, mirrored spectrum, and stereo level modes. Verify switching does not restart capture and test narrow/short layouts.
5. **Distribution:** Validate signed helper identity, arm64/x86_64 policy, downloaded artifact behavior, updates, headphones, CPU/latency, and real Kaset playback before releasing.

The first deliverable should be the capture/isolation proof, not polished animation. It resolves the highest-risk unknown before committing to native packaging or four renderer implementations.

## What is available, and since when?

| Capability                                                | Verified minimum            | Evidence and qualification                                                                                                  |
| --------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `AudioHardwareCreateProcessTap` and destruction           | macOS 14.2                  | Apple symbol metadata and SDK `API_AVAILABLE(macos(14.2))` agree.                                                           |
| `NSAudioCaptureUsageDescription`                          | macOS 14.2                  | Apple documents the purpose string for system-audio capture.                                                                |
| `CATapDescription` class                                  | macOS 12.0                  | The class predates the public tap-creation function. Its availability alone does not make process capture work on macOS 12. |
| `CATapDescription.bundleIDs`                              | macOS 26.0                  | Strings identify processes to include or exclude.                                                                           |
| `CATapDescription.isProcessRestoreEnabled`                | macOS 26.0                  | Saves tapped processes by bundle ID when they exit and restores them when they restart.                                     |
| ScreenCaptureKit framework and `SCStream`                 | macOS 12.3                  | This is not the minimum for its audio output.                                                                               |
| `SCStreamConfiguration.capturesAudio` and `.audio` output | macOS 13.0                  | Both Apple symbol metadata and SDK declarations identify this minimum.                                                      |
| ScreenCaptureKit microphone output                        | macOS 15.0                  | Separate from system audio. `captureMicrophone` defaults to false in the SDK.                                               |
| BlackHole                                                 | macOS 10.10, upstream claim | Current upstream README; not an Apple support promise.                                                                      |

Sources: [A1] [A2] [A3] [A4] [A5] [A8] [O6] [H1] [H2].

Apple's current Core Audio sample page has macOS/Xcode 26 sample metadata, but its setup text says macOS 14.2 or later. Some `CATapDescription` Swift initializers show macOS 14.0. Use the **function required to create the tap** as the capture floor. Do not infer the minimum from the sample's current project version or the description class. [A1] [A2] [H1]

For this host, macOS 26 features are available. A distributed helper should still use availability checks and make its supported floor explicit.

## Option comparison

| Route                           | What it captures                                                                        | Setup and permissions                                                                                        | Main tradeoff                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core Audio process taps         | Included/excluded audio process objects; global mix; optional device/stream restriction | Native helper; system-audio consent; purpose string; transient aggregate device                              | Best audio-only fit. App-to-helper membership and routing recovery need engineering.                                                                            |
| ScreenCaptureKit audio consumer | Audio from filtered applications or a broad display-based capture                       | Native helper; shareable-content/filter setup; screen/system-audio authorization                             | Apple explicitly documents application-level audio filtering. Audio-only consumption does not establish screen-free operation or lower permission requirements. |
| Native CAVA 1.0.0 tap backend   | Global mono/stereo system mix in the inspected implementation                           | Compatible CAVA build; system-audio authorization                                                            | Fast spectrum prototype. Inspected backend lacks a Kaset-only selector and uses private TCC preflight.                                                          |
| BlackHole plus CAVA             | Audio deliberately routed into a virtual device                                         | Driver installation; manual output routing; input authorization may use Microphone privacy                   | Useful independent comparison. Alters the user's audio setup and has multi-output limitations.                                                                  |
| Loopback plus CAVA              | User-selected application/device sources exposed as a virtual device                    | Paid third-party app; ARK installation; administrator authorization; system-audio and microphone permissions | Convenient application selection, but much more setup and permission surface than a native observer.                                                            |

The API and upstream sources establish these capabilities, not compatibility with every music service or audio device. [A2] [A6] [A7] [O4] [O6] [O7]

## Core Audio taps

### Capture path

Apple's sample uses this sequence:

```text
CATapDescription
  → AudioHardwareCreateProcessTap
  → tap UID in a HAL aggregate device
  → start aggregate-device audio I/O
  → AudioBufferList samples
```

The aggregate provides an input stream from captured process output. It is not a requirement to install a HAL driver or change the user's default output. Set the tap and aggregate private where appropriate. Read their negotiated stream format rather than assuming 48 kHz, stereo, float32, or one interleaved buffer. [A2] [H1] [O2] [O4]

For an observer, choose `CATapUnmuted`. Apple specifies that it captures audio **and also sends it to the hardware**. `CATapMuted` and `CATapMutedWhenTapped` suppress the source's normal hardware output. They are appropriate for replacement playback, not this visualizer. [A9] [H1]

Create and destroy the I/O procedure, aggregate, and tap with bounded lifetime. Keep JSON serialization, pipe writes, allocation, and blocking work outside the real-time audio callback. A preallocated bounded ring can hand samples to an analysis worker. These are proposed implementation safeguards, not a measured performance result.

### Process selection is not app selection

`CATapDescription.processes` contains **Core Audio `AudioObjectID` values**, not Unix PIDs. Use `kAudioHardwarePropertyTranslatePIDToProcessObject` to translate a PID. The SDK says an unmatched PID returns `kAudioObjectUnknown` without necessarily returning an error. The process-object list covers clients currently connected to the audio system, not every running app. A source can appear only after playback starts. [H1]

The relevant public properties are:

- `kAudioHardwarePropertyProcessObjectList`: audio clients to enumerate and observe.
- `kAudioProcessPropertyPID` and `kAudioProcessPropertyBundleID`: process identity.
- `kAudioProcessPropertyIsRunningOutput`: active output I/O, not proof of nonzero samples.
- `kAudioProcessPropertyDevices`, with output scope: devices used by a process.
- `AudioObjectAddPropertyListener`/block variant: notifications when the chosen properties change.

Apple's sample observes the process-object and device lists. Re-resolve the selected source after changes. Do not retain a launch-time PID or `AudioObjectID` indefinitely. [A2] [A10] [H1]

On macOS 26, `bundleIDs` can reduce PID bookkeeping. `isProcessRestoreEnabled` explicitly restores processes by bundle ID after restart. The reviewed contract does **not** describe recursive ownership of an app's XPC helpers, how `processes` and `bundleIDs` combine in every configuration, or whether WebKit helpers acquire their client's bundle ID. Prototype these points rather than assuming them. [A3] [A4] [H1]

### Kaset and WebKit

Kaset 0.14.1's `ProcessTapHelper.swift` enumerates Core Audio clients, accepts `com.apple.WebKit.GPU` and `com.apple.WebKit.WebContent`, and then checks parent/child PIDs or legacy process/launcher names. Its comments describe helpers reparented to `launchd` and names such as `Kaset Graphics and Media`. Its tests check parent/child selection, reject unresolved ownership, and accept `Kaset Web Content` and `Kaset Networking` names. These are Kaset implementation choices, not stable ownership guarantees from Apple. [O1]

Consequences for an external helper:

- The current Now Playing app/PID is a selection hint. Tapping only Kaset's main PID can capture silence.
- Selecting every `com.apple.WebKit.GPU` process can also capture Safari or another WebKit app. A shared helper bundle ID is not a safe Kaset selector.
- A parent-PID check alone can miss reparented XPC helpers. Name-prefix matching alone is a heuristic, not a security boundary.
- When ownership is unresolved, report an unavailable source. Do not silently expand to all system audio.
- Monitor process-list changes, app exit/relaunch, and source-device changes. Resolve identities again before rebuilding the tap.

Kaset's equalizer uses `.mutedWhenTapped`, captures WebKit audio, processes it, and renders replacement output. Its service rebuilds after default-output changes. With that equalizer enabled, a WebKit tap may visualize **pre-EQ** audio, while broader output capture may include the replacement render. Concurrent-tap behavior and double counting need an explicit test. Do not copy Kaset's muting or replacement-playback path into a passive visualizer. [O1]

### Devices, headphones, and mute

The description supports an optional output-device UID and hardware-stream index. The SDK states that a device-specific tap follows the selected device stream's format. Global/mixdown selection and device-specific selection are distinct. [H1]

A process may use an output other than the system default. If an aggregate is built around the current default output, changing that default requires reassessing its graph and format. Observe the default-output property, device list, source output-device list, and applicable format changes. Kaset's rebuild strategy is implementation evidence; it is not an automatic-rebinding guarantee from the tap API. [A10] [O1] [H1]

Headphones do not require a microphone route: the API captures rendered output, not sound in the room. Still test wired headphones, Bluetooth reconnects, and profile/sample-rate changes. AirPlay or playback delegated to another device can have a different path and is outside an initial local-output claim.

Keep three kinds of mute separate:

1. **Tap mute behavior:** Apple specifies whether the tap suppresses hardware playback.
2. **Hardware/output volume or mute:** the reviewed contract does not locate capture precisely before or after every hardware gain stage.
3. **Player/tab volume or mute:** the app may render reduced samples, zeros, or stop I/O.

Therefore, bars following system volume, bars remaining active while the device is muted, and bars going flat after in-player mute are **prototype observations to collect**, not established guarantees. A silent buffer does not prove permission denial, DRM, or a wrong source.

## ScreenCaptureKit as an alternate route

Set `capturesAudio = true` and attach an `.audio` stream output. Audio arrives in `CMSampleBuffer` objects containing audio buffers. Sample rate and channel count are configurable. Leave `captureMicrophone` false, and do not attach `.microphone` output. [A5] [A8] [H2]

Apple's WWDC22 explanation is precise: **audio filtering is at application level**. Capturing a single Safari window includes audio from other Safari windows. Excluding one window's audio can exclude the containing app's audio. It does not offer track-, tab-, or Now Playing item-level isolation. Application inclusion is therefore preferable to window tricks for this investigation. [A6] [A7]

This contract makes a Kaset application filter worth comparing with explicit Core Audio process selection. It does not separately guarantee Kaset's WebKit attribution, recovery after relaunch, headless operation, or every minimized/windowless state. [A6] [A7]

There is no `capturesVideo = false` property in the inspected `SCStreamConfiguration` header. Registering only an audio consumer avoids delivering screen samples to that consumer, but does **not** prove that screen machinery is absent. OBS's dedicated macOS audio source actually adds a dummy `.screen` output to suppress ScreenCaptureKit errors and discards those frames. Measure the exact proposed configuration. Do not describe it as permission-free audio capture. [H2] [O8]

Apple's sample requests Screen Recording permission. Apple's macOS 26 guide distinguishes authorization for screen plus audio from authorization for audio only. The reviewed sample does not establish which authorization is sufficient for every audio-only `SCStream` configuration and shareable-content query on macOS 26.6.2. Test this independently from the Core Audio tap flow. [A11] [A12]

## Permissions and distribution

### What Apple documents

- Include `NSAudioCaptureUsageDescription` with an accurate reason. Apple's tap sample says the first recording from an aggregate containing a tap prompts for system-audio recording permission. Calling tap creation successfully is not the same as receiving audio. [A2] [A13]
- System-audio consent is distinct from microphone consent. Apple's macOS 26 privacy UI allows audio-only access. No physical microphone is needed for the native tap route. [A12] [A13]
- Apple's sandboxed tap sample includes `com.apple.security.device.audio-input`. Apple's entitlement documentation covers microphone recording **and Core Audio input access**. This entitlement is not itself a command to record the microphone and does not replace user consent. The sample's only capture purpose string is the system-audio string. [A2] [A14]
- Xcode supports an embedded Info.plist for command-line targets through `CREATE_INFOPLIST_SECTION_IN_BINARY`, creating `__TEXT,__info_plist`. A CLI is not categorically unable to carry the purpose string. [A15]
- Stable signed code identity matters for retained privacy choices. Apple explains that unsigned or ad hoc builds cannot reliably preserve identity across versions. Its example concerns microphone authorization; confirm the same release/update behavior for the system-audio service. [A16]

### What remains unresolved for this launch chain

The real launch chain is terminal/OpenCode → Bun/Node owner daemon → native child. Apple documentation reviewed here does not establish which executable or enclosing application receives audio TCC attribution for every such chain.

AudioTee's README reports terminal-dependent prompting. CAVA 1.0.0's tap code directs users to authorize their terminal. These are upstream observations and implementation assumptions, not an Apple promise that the terminal always owns permission. [O2] [O4]

Compare a signed standalone CLI with embedded Info.plist against a small signed helper `.app` with a stable bundle ID. Test direct invocation of its binary and launching the app through the system's app-launch path. **Putting a binary inside an app bundle alone does not verify independent TCC attribution.** Distribution and launch choice should follow that result.

Do not label missing samples as definitively denied. Preserve separate states for user-requested off, OS unsupported, helper missing, source unresolved, starting, receiving silent samples, receiving signal, and explicit capture failure. Report an authorization denial only when the available evidence establishes it. Do not invent a public authorization-status API.

AudioCap's optional authorization code calls `TCCAccessPreflight`/`TCCAccessRequest` from the **private** TCC framework. CAVA's native tap backend also uses private TCC preflight. Neither is a suitable basis for claiming a public, stable permission API. Kaset uses `CGPreflightScreenCaptureAccess`; that checks screen capture and is not documented in the reviewed pages as a precise system-audio-only permission test. Do not copy either assumption into the production helper without establishing the correct behavior. [O1] [O3] [O4]

### Shipping a helper

A native helper adds a release artifact, not just an npm dependency. Plan arm64/x86_64 support or an explicit architecture restriction, a declared deployment target, a stable identity, a helper version handshake, trusted artifact integrity, and update/cleanup behavior.

For a normal Developer ID distribution, Apple's notarization requirements include signing all distributed executables, Developer ID credentials, Hardened Runtime, a secure timestamp, and no enabled `get-task-allow`. Notarization is separate from capture authorization. It does not grant system-audio access. [A17]

Apple allows notarizing CLI binaries, but cannot staple tickets directly to standalone binaries or ZIP files. A stapleable app, disk image, or flat installer package is relevant for offline Gatekeeper validation. Test the actual downloaded/quarantined artifact and update, not only a locally built helper. An app archive installed in a user-writable location need not imply an administrator-installed audio driver. [A18]

Do not solve authorization by disabling SIP, removing quarantine automatically, editing TCC databases, using `sudo`, or requesting Full Disk Access/Accessibility without a separate documented need.

## CAVA and virtual-device prototypes

### CAVA 1.0.0 changes the comparison

The release contains native Core Audio support. Its README/config document `method = coreaudio` with `source = tap` or `tap_mono` on macOS 14.2+, when built with tap support. The inspected tap backend uses a private global tap, `.unmuted`, an aggregate device, and HAL I/O. It accepts a global mix, not an included-process list. A particular Homebrew installation or older release must be checked; the upstream source is not proof of its installed features. [O4] [O5]

Its raw output is **not NDJSON**. It emits binary bar heights or configurable ASCII values separated by bar/frame delimiters. A daemon adapter can validate a fixed count and convert the ASCII frames into bounded feature events. Use raw mode instead of letting CAVA take over the terminal. [O4]

CAVA documents logarithmic band grouping, sensitivity adjustment, and smoothing. Its README says it favors responsive, aesthetic output rather than scientific measurement. This is useful for an independent bar-spectrum comparison. It is not a calibrated loudness meter. [O4]

For selectable spectrum, waveform, and level styles, one bar-height stream is not sufficient for every style. CAVA has a waveform option, but its single configured raw stream is not a simultaneous transport for arbitrary PCM, spectrum, stereo levels, and waveform points. Avoid restarting capture each time the user changes presentation.

CAVA's top-level code license is MIT, but its FFTW dependency is GPL-2.0-or-later, with alternative licensing available. Check the complete distribution's dependency obligations before bundling a binary or linking `cavacore`. Running a separately installed optional CAVA process and embedding its dependencies are different distribution choices. [O4] [A19]

### BlackHole

BlackHole's upstream supports Intel/Apple Silicon and says no kernel extension or reduced system security is needed. It still requires installing a HAL virtual driver and routing audio into it. To continue hearing audio, users normally configure a multi-output device containing the real output and BlackHole. The upstream documents loss of normal multi-output volume control, clock/drift setup, and AirPods caveats. Its “zero additional driver latency” claim is not a zero-latency guarantee for the complete capture/FFT/terminal path. [O6]

Its FAQ instructs recording apps to obtain Microphone privacy access even for this virtual input. Never choose the default input device as a fallback: it may be a physical microphone. This route can remain an explicitly selected optional prototype, with the user handling installation and routing. [O6]

BlackHole is GPL-3.0 and its upstream requires a separate license for integration into non-GPL projects. Do not silently bundle it into this MIT repository. [O6]

### Loopback

Loopback offers application sources and virtual devices. Its application source's **“Mute when capturing” is on by default**; leaving that enabled would suppress normal playback when the visualizer reads its device. An observer comparison must account for this. [O7a]

Current vendor documentation requires installing ARK with administrator authorization, and granting ARK both system-audio and microphone access. The product page lists Loopback 2.5.0 as supporting macOS 14.5–27. These are vendor requirements, not an alternative that avoids permissions. It can help users who already own it, but it is not the suggested default. [O7] [O7b]

## Native helper, JavaScript FFT, or CAVA?

All three analysis approaches still need a real sample source. Metadata, playback position, and a timer cannot reveal the sound's frequency or amplitude.

| Analysis placement                                 | Useful evidence                                                                                                           | Cost and limitation                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native helper does analysis, emits features        | Apple Accelerate supplies vDSP Fourier-transform APIs. Native capture and analysis can keep PCM inside one process.       | Requires native DSP code and tests. Small daemon frames; host renderers stay independent of audio formats.                                                                  |
| Native capture emits PCM; Bun/Node worker does FFT | AudioTee demonstrates PCM on stdout, separate metadata/logging on stderr, mono/stereo configuration, and PID translation. | Easier to experiment with JS analysis, but more copying, framing, format handling, and runtime load. Do not put real-time callbacks or heavy analysis on the UI event loop. |
| CAVA process emits spectrum heights                | Existing grouping, smoothing, automatic sensitivity, and raw output.                                                      | Fast spectrum comparison, but extra dependency, version/configuration coupling, private preflight in the inspected tap backend, and limited shared feature data.            |

Sources: [A20] [O2] [O4]. These are architectural alternatives, not verified benchmarks.

AudioTee is **reference code, not a drop-in production recommendation**. Its default chunks are 200 ms, its README warns of API instability, and the inspected implementation supports only the default output. A pending upstream patch reports silent buffers from its post-creation tap-list assignment on macOS 26. Use that as a compatibility hypothesis to test, not an Apple contract or a proven local failure. [O2] [O9]

For a native feature stream, a useful candidate set is:

- Timestamp, sequence, source generation, and actual sample rate.
- Fixed-count log-frequency band magnitudes for bars and spectrum-derived styles.
- RMS/peak levels, optionally separate left/right levels.
- Optional bounded signed waveform samples or min/max envelopes, depending on the intended waveform rendering.
- Explicit lifecycle/status events independent of signal values.

Encode bounded feature/status events as NDJSON and keep diagnostics on stderr. This is a proposed helper protocol, not an Apple or AudioTee format. Do not serialize raw PCM as JSON arrays.

Spectrum magnitudes do not contain the waveform's phase. An RMS envelope is not a reconstructed waveform. A beat pulse requires additional onset/beat analysis; do not claim reliable tempo from loudness alone.

**Brief integration direction:** let the singleton daemon own one native child and one analysis stream. Share latest feature frames across clients through the existing same-user socket. Bound lines, arrays, numeric values, queues, and retained history. A slow viewer should lose intermediate visualization frames rather than delay media controls. Stop capture when there are no interested clients or the user disables it. The parent investigation should select the exact protocol changes.

The proposed helper should capture no microphone, persist no PCM, upload no audio, and use no network analysis service. Native callbacks still receive audio in memory. Feature frames can still reveal activity; these properties are data-handling requirements, not an assertion that visualization data is harmless. A global system mix can include notifications or calls, so require a separate explicit choice rather than using it as a hidden app-selection fallback.

## Latency and CPU: calculations, not promises

At 48 kHz:

| Quantity                      | Arithmetic                            | Meaning                                                  |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------- |
| 1,024-sample transform window | 21.33 ms; 46.875 Hz bin spacing       | Shorter observation span, less low-frequency resolution. |
| 2,048-sample transform window | 42.67 ms; 23.4375 Hz bin spacing      | More low-frequency resolution, longer observation span.  |
| 512-sample hop                | 10.67 ms                              | Possible analysis cadence; it need not equal UI cadence. |
| 30 feature frames/second      | 33.33 ms between frames               | Candidate terminal update cap.                           |
| Stereo float32 PCM            | 48,000 × 2 × 4 = 384,000 bytes/second | Before copies and transport framing.                     |
| Mono float32 PCM              | 192,000 bytes/second                  | Before copies and transport framing.                     |

These are mathematical sizes and intervals. They are not capture-to-display measurements. Hardware buffers, callback scheduling, FFT overlap, smoothing, transport, terminal rendering, and Bluetooth playback buffering affect alignment with what the user hears.

AudioTee's default 200 ms chunks limit updates to roughly five chunks per second and can add nearly a chunk of wait before transport. It is a poor default for fast bars. CAVA's documented default is 60 fps with substantial smoothing; neither default is a benchmark for this plugin. [O2] [O4]

Start the comparison around a 1,024- or 2,048-sample window and 20–30 feature frames per second. Keep attack fast and release controlled. Measure whether a lower rate looks adequate before paying for 60 terminal updates per second. Native Accelerate analysis is a reasonable candidate, not proof of a specific CPU advantage. [A20]

Suggested **prototype targets**, to adjust after measurement: p95 sample timestamp-to-render age below 150 ms, capture plus analysis below 5% of one CPU core on the test Mac, and no steady memory growth over 30 minutes. Report hardware, output route, analysis settings, one/multiple clients, and idle/active state. Apple’s WWDC ScreenCaptureKit CPU/RAM comparisons concern video capture and must not be quoted as this audio-only path's budget. [A7]

## Protected content and other evidence limits

No reviewed Apple tap/SCK reference establishes a universal answer for DRM-protected **audio**. Do not promise that Spotify, Apple Music, YouTube Music, or every protected stream will always deliver samples. Also do not state that all DRM audio necessarily produces silence.

Apple documents that protected `AVPlayer` items can have **visual content** obscured when device protection is insufficient. That is not a documented blanket audio-tap prohibition. [A21]

An upstream Steno issue reports black Apple TV/Netflix video while an audio-consuming ScreenCaptureKit display stream runs, with audio continuing. This is a firsthand compatibility report, not an Apple guarantee. Its proposed permission-free Core Audio alternative is **not** supported by Apple's tap-permission documentation. Treat the video interference report as a reason to test playback side effects, not as a normative API description. [O10] [A2]

Remaining unknowns:

- Exact TCC attribution and prompting for the daemon's final packaged launch chain.
- Audio-only SCK authorization versus its shareable-content setup on macOS 26.6.2.
- Kaset bundle-ID selection versus explicit WebKit process selection, including PID churn and reparenting.
- Concurrent taps and pre-/post-EQ behavior with Kaset's equalizer enabled.
- Default/output-device following, format renegotiation, and Bluetooth timing.
- Hardware mute/volume behavior, app mute, valid silent tracks, and absent callbacks.
- Service/content-specific capture restrictions and unintended protected-video effects.
- Measured native versus JS versus CAVA CPU, energy, memory, and end-to-end responsiveness.

## Suggested MVP and prototype acceptance tests

The candidate MVP is macOS 14.2+ Core Audio capture in a signed helper, with opt-in authorization, explicit source selection, unmuted playback, and native feature-only output. Enable macOS 26 selection/restoration only after it passes the same isolation tests. Keep metadata and transport controls usable when capture is absent. Do not require CAVA, BlackHole, Loopback, or a microphone.

These are proposed future experiments. **None was run in this research.** Any capture or permission experiment requires the user's explicit approval.

| Experiment                   | Passing evidence and why it matters                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signal rather than animation | Controlled tones move the expected frequency bands; impulses affect levels; a silence interval yields zeros/decay. Changing only elapsed time must not create energy. This proves the data follows PCM.                                            |
| Actual Kaset playback        | Kaset 0.14.1 produces nonzero signal through the selected helper identity while metadata identifies Kaset. Document WebKit PID, audio object, bundle ID, and selector used. This proves the integration's source.                                  |
| Isolation                    | Run Kaset and another WebKit app with distinct sounds. Kaset-only mode must exclude the second sound. Unresolved ownership must remain unavailable, not become a global mix. This protects privacy and visual truth.                               |
| Permission lifecycle         | From an unapproved test account/build, observe the actual named prompt and settings entry; test allow, deny, revoke, retry, and helper update. Do not reset the user's TCC state for convenience. Silence must not be reported as definite denial. |
| Packaging                    | Compare signed embedded-plist CLI and helper app launch paths under the actual terminal → daemon chain. Test the downloaded/quarantined artifact, update identity, and offline Gatekeeper behavior. A dev build is insufficient release evidence.  |
| PID/helper churn             | Start paused, begin playback, change tracks, relaunch Kaset, and recreate WebKit helpers in a controlled session. Capture must bind only to the new intended objects and retire stale frames.                                                      |
| Device changes               | Switch built-in output, wired headphones, Bluetooth, and a nondefault app output where available. Record sample format, recovery time, and audible continuity. Do not claim automatic default following from one static run.                       |
| Passive operation and EQ     | Start/stop/crash the observer with Kaset EQ off/on. Music must remain audible, with unchanged volume/routing and no duplicate playback. Document whether analysis follows pre- or post-EQ audio.                                                   |
| Mute and silence             | Test hardware mute/zero volume, player mute/zero volume, pause, silent content, and no source. Show observed energy separately from capture state; do not manufacture signal or misdiagnose permissions.                                           |
| Protected playback           | With permission, compare ordinary local audio and the user's actual service/content. Check audio samples and source playback, including protected video while SCK runs. Report results per content and route; do not bypass restrictions.          |
| Shared stream and styles     | Two clients consume one helper. Style changes do not restart capture, reprompt, or change the selected source. Waveform styles use time-domain data, not renamed spectrum bars.                                                                    |
| Backpressure and failure     | Slow/frozen viewer, malformed helper line, helper exit, daemon restart, and client disconnect remain bounded. Media controls continue; stale features decay or become unavailable; private audio resources are released.                           |
| Performance and privacy      | Measure timestamp-to-render percentiles, CPU, memory/energy, and drop counts for 30 minutes. Inspect writes/network activity: no PCM files, audio-bearing logs, uploads, or physical-input capture.                                                |

## Verification scope

- **Verified from sources:** Apple symbol availability, SDK declarations/comments, sample permission/plist/entitlement setup, app-level SCK filtering, CLI embedded Info.plist support, notarization constraints, and the cited upstream implementations.
- **Untested:** native compilation, actual audio, TCC attribution, protected playback, device behavior, and CPU/latency. No user permissions or audio routing were changed.
- **Toolchain observation:** `xcrun --show-sdk-path` printed a loader-library error while returning the SDK path. Header inspection succeeded directly. No native build result is claimed.
- **Workspace checks:** research-clone lint/type-check were blocked by absent dependencies. After integration into the installed main checkout, workspace lint and all seven project type-check targets passed; Nx reused matching cached type-check results. No production code changed.
- **Documentation checks passed:** Prettier checked this file. Glow rendered the capture report at 100 columns and the integrated design sections at 120 columns. All 35 original citation targets resolved, using DocC JSON for Apple reference pages; the added local source links were checked against the repository. The numeric window/rate calculations were checked with Bun. This does not verify website CSS or interactive behavior. No source implementation changed.

## Sources

### Apple documentation and sample code

- [A1] — `AudioHardwareCreateProcessTap`: macOS 14.2 availability. The page's DocC JSON supplied the availability metadata.
- [A2] — _Capturing system audio with Core Audio taps_: capture path, private taps, aggregate devices, macOS 14.2 setup, and system-audio prompt. The linked sample archive's `Model.swift`, `Info.plist`, and `AudioTapSample.entitlements` were inspected without extraction to disk.
- [A3] / [A4] — macOS 26 bundle-ID selection and process restoration.
- [A5] / [A8] — SCK `capturesAudio` and audio-output availability; see also the SDK header below for separate microphone defaults.
- [A6] / [A7] — WWDC22 transcripts: application-level audio filtering, Safari examples, consent, and video performance scope.
- [A9] / [A10] — tap mute semantics and audio property listeners.
- [A11] / [A12] — Apple SCK sample and macOS 26 user guide on recording permissions.
- [A13] / [A14] / [A15] — system-audio purpose string, Audio Input entitlement, and CLI embedded Info.plist build setting.
- [A16] / [A17] / [A18] — signed identity, Developer ID notarization, and ticket/container restrictions.
- [A19] — FFTW's first-party licensing documentation; not an Apple source.
- [A20] / [A21] — Accelerate Fourier transforms and AVPlayer's protected visual-output state.

### SDK headers

[H1] is Apple's installed **macOS 27.0 SDK**, identified through `SDKSettings.json`, not the host's OS version. Historical availability annotations agree with the cited Apple symbol pages. Inspected files:

```text
/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/
  System/Library/Frameworks/CoreAudio.framework/Versions/A/Headers/
    AudioHardwareTapping.h:33–54       # process-tap functions: macOS 14.2
    CATapDescription.h:19–34          # mute behavior
    CATapDescription.h:49–111         # process mixdown and device streams
    CATapDescription.h:125–167        # AudioObjectIDs; bundle IDs/restore: macOS 26
    AudioHardware.h:586–595           # process list and PID translation
    AudioHardware.h:1948–1969         # process identity, devices, output activity
```

[H2] is the same SDK's `ScreenCaptureKit.framework/Versions/A/Headers/SCStream.h`: lines 34–38 and 313–330 declare macOS 13 audio support; lines 377–385 declare separate, default-off microphone capture. Lines 102–200 and 202–400 were inspected for filter/configuration properties. SDK declarations are first-party evidence, not a test on macOS 26.6.2.

### Upstream implementation evidence, not Apple contracts

- [O1] — Kaset **v0.14.1**, commit `1cf9a1a021341a8ee2a0c82f26be2633db8a1c98`: `ProcessTapHelper.swift`; related `EqualizerAudioEngine.swift`, `EqualizerService.swift`, and `Tests/KasetTests/ProcessTapHelperTests.swift` at that commit were also inspected.
- [O2] — AudioTee commit `56ac954369a09318e46b88a6eec33c2d2b0d32a3`: README, package configuration, `AudioTapManager.swift`, and `AudioRecorder.swift`.
- [O3] — AudioCap commit `6f609e8ad1b1e11fa0e8edbe91864cb099f00de3`: optional private-TCC permission code and app configuration.
- [O4] / [O5] — CAVA **1.0.0**, commit `15f89867908fa66baaaec8d4b9a2d684a329a0fb`: README, config, Core Audio tap backend, raw-output writer, `CAVACORE.md`, and MIT license; release notes establish shipped native support.
- [O6] — BlackHole README at commit `62953f570329839e6188f02cc28934904147f617`: routing, supported OS, permissions, multi-output caveats, and licensing.
- [O7] / [O7a] / [O7b] — Loopback vendor permissions manual, application-source manual, and product page: ARK installation, required permissions, default muting, and current supported OS range.
- [O8] — OBS commit `cffa83ba552f1ef6a0a05851c3aa07b3811d7e58`: dedicated SCK audio source and dummy screen output.
- [O9] — AudioTee PR #14: **unverified upstream report/proposed fix** for silent buffers on macOS 26.
- [O10] — Steno issue #103: **upstream reproduction report**, not verified here; do not adopt its unsupported permission claim.

[A1]: https://developer.apple.com/documentation/coreaudio/audiohardwarecreateprocesstap(_:_:)
[A2]: https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps
[A3]: https://developer.apple.com/documentation/coreaudio/catapdescription/bundleids
[A4]: https://developer.apple.com/documentation/coreaudio/catapdescription/isprocessrestoreenabled
[A5]: https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio
[A6]: https://developer.apple.com/videos/play/wwdc2022/10156/
[A7]: https://developer.apple.com/videos/play/wwdc2022/10155/
[A8]: https://developer.apple.com/documentation/screencapturekit/scstreamoutputtype/audio
[A9]: https://developer.apple.com/documentation/coreaudio/catapmutebehavior
[A10]: https://developer.apple.com/documentation/coreaudio/audioobjectaddpropertylistener(_:_:_:_:)
[A11]: https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos
[A12]: https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/26/mac/26
[A13]: https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription
[A14]: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input
[A15]: https://developer.apple.com/documentation/xcode/build-settings-reference#Create-Infoplist-Section-in-Binary
[A16]: https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements
[A17]: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
[A18]: https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
[A19]: https://www.fftw.org/doc/License-and-Copyright.html
[A20]: https://developer.apple.com/documentation/accelerate/fast-fourier-transforms
[A21]: https://developer.apple.com/documentation/avfoundation/avplayer/isoutputobscuredduetoinsufficientexternalprotection
[H1]: #sdk-headers
[H2]: #sdk-headers
[O1]: https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Services/Audio/ProcessTapHelper.swift
[O2]: https://github.com/makeusabrew/audiotee/tree/56ac954369a09318e46b88a6eec33c2d2b0d32a3
[O3]: https://github.com/insidegui/AudioCap/blob/6f609e8ad1b1e11fa0e8edbe91864cb099f00de3/AudioCap/ProcessTap/AudioRecordingPermission.swift
[O4]: https://github.com/karlstav/cava/tree/15f89867908fa66baaaec8d4b9a2d684a329a0fb
[O5]: https://github.com/karlstav/cava/releases/tag/1.0.0
[O6]: https://github.com/ExistentialAudio/BlackHole/blob/62953f570329839e6188f02cc28934904147f617/README.md
[O7]: https://rogueamoeba.com/support/manuals/loopback/?page=Permissions
[O7a]: https://rogueamoeba.com/support/manuals/loopback/?page=sources
[O7b]: https://rogueamoeba.com/loopback/
[O8]: https://github.com/obsproject/obs-studio/blob/cffa83ba552f1ef6a0a05851c3aa07b3811d7e58/plugins/mac-capture/mac-sck-audio-capture.m
[O9]: https://github.com/makeusabrew/audiotee/pull/14
[O10]: https://github.com/jwulff/steno/issues/103
