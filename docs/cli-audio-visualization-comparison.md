# How terminal players obtain audio for visualization

**The plugin does not need to become a music player.** CLIAMP analyzes PCM inside its own playback pipeline. MPD can give another process a PCM feed. A player-agnostic observer can instead capture the selected app's output, with permission. These are different sample sources for the same analysis and rendering model.

Research date: 2026-10-03. This is a source comparison, not a tested integration. No player, capture tool, driver, dependency, permission, or audio-routing change was installed or enabled. The [capture research](music-audio-visualization-research.md) supplies the existing plugin context and detailed macOS risks.

## Pinned sources

Each implementation claim below refers to these commits, not an unpinned README or an installed binary.

| Project                            | Inspected branch or tag | Commit                                                                                                                               |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| CLIAMP                             | `main`                  | [`9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16`](https://github.com/bjarneo/cliamp/tree/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16)        |
| Beep, CLIAMP's playback dependency | `v2.1.1`                | [`e2b0015c40fc5a25cd7b2705004274359b2c422b`](https://github.com/gopxl/beep/tree/e2b0015c40fc5a25cd7b2705004274359b2c422b)            |
| ncmpcpp                            | `master`                | [`84fc45f0cc4f5bdf8b350fc22bfa6cc1392a52e4`](https://github.com/ncmpcpp/ncmpcpp/tree/84fc45f0cc4f5bdf8b350fc22bfa6cc1392a52e4)       |
| MPD                                | `master`                | [`a6664887665a3b39ea326a70da5afa4b5c6594c5`](https://github.com/MusicPlayerDaemon/MPD/tree/a6664887665a3b39ea326a70da5afa4b5c6594c5) |
| mpv                                | `master`                | [`413ff0b1cd4585294803308a1a14be2fad30cede`](https://github.com/mpv-player/mpv/tree/413ff0b1cd4585294803308a1a14be2fad30cede)        |
| FFmpeg filter implementations      | `master`                | [`5a23ac8460a7bc1c2cdbf6ac62bd67e023451b8f`](https://github.com/FFmpeg/FFmpeg/tree/5a23ac8460a7bc1c2cdbf6ac62bd67e023451b8f)         |
| CAVA                               | `master`                | [`299219826379e137f0f4c48bfdc96019360964ec`](https://github.com/karlstav/cava/tree/299219826379e137f0f4c48bfdc96019360964ec)         |

The FFmpeg commit explains the filters. It does not establish which FFmpeg build a user's mpv links. The CAVA comparison uses a newer source snapshot than the capture report's pinned 1.0.0 release.

## Four pipelines, two ways to obtain samples

| Example           | Sample and analysis path                                                                                        | Audible output                                                            | What our observer can reuse                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLIAMP            | Decode/resample → gapless/speed/EQ → internal stereo ring → mono Hann-window FFT, raw waveform, or L/R RMS/peak | The same stream continues through volume/mono → Beep speaker → Oto output | Local spectrum IPC from an existing CLIAMP player. No reviewed IPC/Lua PCM, waveform, or L/R level export. [C1] [C4] [C7] [C8]                                                |
| ncmpcpp + MPD     | MPD playback → separate raw PCM FIFO → ncmpcpp's sample buffer → FFTW spectrum or time-domain drawing           | MPD's separate configured device output                                   | Read MPD's configured PCM FIFO directly; the plugin need not decode or play music. This is a player-provided feed, not arbitrary-app capture. [N1] [N2] [N3]                  |
| mpv + libavfilter | Selected decoded audio track → `asplit` → audio branch and visualization filter branch                          | `[ao]` continues to audio output; `[vo]` receives visualization video     | Configured `astats` metadata can supply levels through mpv properties/IPC. `showwaves`/`showspectrum` produce video, not a ready terminal feature stream. [M1] [M3] [M4] [M5] |
| CAVA standalone   | Chosen monitor/device/FIFO/tap → PCM → FFTW bands, or a separate waveform path                                  | CAVA observes; the source player remains responsible for playback         | Raw spectrum heights, or configured waveform display values. Its inspected macOS tap selects a global mix, not one music app. [V1] [V2] [V3] [V4]                             |

CLIAMP and mpv own the decoded audio they analyze. ncmpcpp is a useful counterexample: the controller and visualizer can live outside the playback process when the player supplies PCM. CAVA shows the other route: obtain samples from an audio backend without becoming the player.

## CLIAMP: what actually reaches the visualizer?

The source describes its pipeline explicitly:

```text
Decoded current/next track → resampling → gapless → speed → 10-band EQ
  → tap.Stream(stereo float64 frames) → volume + mono → Ctrl → speaker
       └→ stereo ring buffer
            ├→ mono sample window → Hann → radix-2 FFT → band power → smoothing
            ├→ audible-position mono samples → Wave / Scope
            └→ stereo samples → L/R RMS and sample peaks → Stereo
```

`player/player.go:28–36, 285–303` places the tap **after EQ and before volume/mono**. `tap.Stream` copies actual samples and then returns them to playback. This “tap” is an internal Go streamer, not an Apple process tap. Beep's speaker creates an Oto output player. Nothing in this reviewed path records another app. [C1] [C2] [C3]

`ui/vis_analyze.go:157–250` saves raw samples separately, applies a Hann window, runs CLIAMP's own radix-2 FFT, and converts band power to clamped, smoothed display values. The normal spec uses 2,048 samples and 10 bands. `ClassicPeak` instead requests 4,096 samples and 64 bands. These display levels are not calibrated loudness. [C4] [C5]

Waveform reads compensate for the configured speaker-buffer lag and advance from the wall clock. This is an alignment strategy in the code, not a measured end-to-end latency guarantee. The model can optionally apply the player's volume gain to analysis. Stereo analysis also accounts for the player's mono setting. Neither establishes hardware-volume tracking. [C2] [C6]

### Existing export surfaces

| Surface                                  | Verified contract                                                                               | Limit for an external renderer                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cliamp visstream --fps …`               | Polls V2 `spectrum.get` on one local socket; writes plain NDJSON. Default 30 FPS, allowed 1–60. | Spectrum only. Polling faster does not guarantee fresh analysis each frame. [C7]                                                                                                         |
| V2 `spectrum.get`                        | Returns `visualizer` and a copy of `SmoothedBands()`.                                           | Count follows the active analysis spec; do not assume every frame has 10 bands. Raw-sample modes do not update `v.bands`, so a mode change can leave old spectrum data. [C5] [C15] [C16] |
| V2 `state.get`                           | Playback/track snapshot, settings, EQ gains, visualizer name.                                   | EQ gains are settings, not measured spectrum. No raw PCM, waveform, or stereo meter fields in the reviewed snapshot/response. [C7]                                                       |
| Lua `p:render(bands, frame, rows, cols)` | Ten normalized spectrum values and display dimensions; returns terminal text.                   | The callback receives no PCM or stereo levels. Lua `p:publish` can forward data it already has, but cannot recover missing samples. [C8]                                                 |
| Lua `cliamp.http.get/post`               | An outbound HTTP client; private and loopback destinations are blocked.                         | Not an HTTP audio-analysis server or a local PCM feed. [C9]                                                                                                                              |
| Go `player.Engine`                       | `SamplesInto`, `WaveformSamplesInto`, `StereoSamplesInto`, `SampleRate`.                        | An in-process playback interface. It is not an IPC export for another running process. [C10]                                                                                             |

**CLIAMP has a real analysis export, separate from Now Playing metadata.** Our plugin could consume that API while CLIAMP remains the player. It would cover spectrum and mirrored-spectrum styles, subject to the mode/freshness limits. It would not cover a truthful oscilloscope or stereo levels without another sample source or an upstream export extension.

Headless CLIAMP still runs the same player. Its documentation says it exposes APIs without a screen; starting it does not turn it into an observer of Spotify, Kaset, or another app. [C7]

## ncmpcpp + MPD: the player-provided PCM pattern

MPD's documentation says: “The fifo plugin writes raw PCM data to a FIFO … The data can be read by another program.” MPD permits multiple `audio_output` blocks, so the FIFO feed can accompany normal audible output. `FifoOutput::Play` writes the supplied audio bytes; it does not obtain PCM from Now Playing metadata. [N1]

ncmpcpp's own config requires `44100:16:1` or `44100:16:2`. Its visualizer reads signed 16-bit samples, splits stereo channels when configured, and selects the drawing function. Spectrum mode executes an FFTW transform. `ApplyWindow` implements a Blackman window, despite an older call-site comment saying Hamming. Wave mode averages signed PCM samples per column; wave-filled takes the absolute value of that average. [N2] [N3]

This is a practical optional adapter for an existing MPD user. It is not a universal way to observe arbitrary macOS players. A FIFO's readers consume bytes rather than each receiving a broadcast copy. Our singleton daemon should own a dedicated configured feed and distribute analyzed frames; sharing ncmpcpp's FIFO between independent readers would need separate coordination. The upstream config also warns about audible/visual timing divergence. [N1] [N2]

## mpv: analysis filters are inside playback

mpv's manual maps `[aidN]` to an audio track, `[ao]` to audio output, and `[vo]` to video output. Its official example uses `asplit` and `showvolume` to keep sound playing while displaying measured levels. `filters/f_lavfi.c` converts mpv audio frames to `AVFrame` and sends them to libavfilter. [M1] [M2]

FFmpeg's `showwaves` draws signed time samples. `showspectrum` windows PCM, computes an FFT, and renders frequency/time image data. These are actual audio-derived pictures, but integrating their video output into a small terminal sidebar is different work from consuming compact spectrum/waveform/level frames. mpv can run from a terminal; its visualization output is not inherently terminal-cell art. [M3] [M6]

There is a narrower reusable export: mpv documents `af-metadata/<filter-label>`, and JSON IPC reads/observes properties. With a deliberately configured `astats` audio filter, FFmpeg injects per-channel `lavfi.astats.N.RMS_level` and `Peak_level` metadata. `metadata=1` enables it; `reset` controls the cumulative frame interval. This can support a player-specific meter adapter without OS output capture. It still supplies no waveform or full spectrum, and it requires changing that player's filter configuration. The combined integration was not run. [M4] [M5]

## Does “wave” always mean time-domain samples?

No. A style name cannot establish the data's meaning. These are source-verified examples, not a popularity ranking or an audit of every mode.

| Style/example                   | Actual input                                                                 | Interpretation                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| CLIAMP Bars / Mirror            | FFT-derived bands                                                            | Frequency displays; mirroring reuses the same bands. [C4] [C5]                                                      |
| CLIAMP Wave                     | Mono signed PCM, point-sampled across Braille columns                        | Time-domain trace. The reduction can miss peaks; it is not a full-resolution instrument. [C11]                      |
| CLIAMP Scope                    | Mono PCM against a delayed copy of itself; delay changes with animation time | Real sample-driven XY art, **not a left/right phase scope**. [C12]                                                  |
| CLIAMP Stereo                   | Per-channel RMS and maximum absolute sample amplitude                        | Real stereo level/peak meters with display easing and peak hold; not proof of calibrated VU or LUFS behavior. [C13] |
| CLIAMP Retro's horizon “wave”   | Cosine interpolation between spectrum bands, with a nonzero floor            | An audio-reactive frequency curve, not an oscilloscope waveform. [C14]                                              |
| ncmpcpp wave / wave-filled      | Signed PCM bucket averages / absolute bucket averages                        | Time-domain reductions, not FFT reconstruction. Stereo ellipse directly plots L/R sample coordinates. [N3]          |
| FFmpeg showwaves / showspectrum | PCM samples / windowed FFT                                                   | Waveform / spectrogram video respectively. [M3]                                                                     |
| CAVA `waveform = 1`             | Recent PCM; stereo averages L/R; sensitivity and display scaling             | A separate time-sample path, not a synthetic curve recovered from FFT bars. It is not an unchanged PCM export. [V3] |

Spectrum, mirrored spectrum, waveform, and stereo meters are established examples across these sources. Particle, pulse, landscape, and other decorative modes can use measured energy while synthesizing their geometry. That does not make them faithful sample plots. This report makes no promise to reproduce “31 modes” or preserve stereo phase from band magnitudes.

## Recommendation for this plugin

Keep music control, audio sourcing, analysis, and rendering separate. Generalize the source selector rather than hardcoding Kaset:

```text
Auto: current Now Playing app identity     Manual: selected music app/player
                      └──────────────┬──────────────┘
                            verified source binding
                                     ↓
            player-provided PCM/features OR opt-in app-output capture
                                     ↓
               analyze PCM once OR validate supplied feature capabilities
                                     ↓
                 singleton daemon → independent style renderers
```

This is a proposed design, not an existing plugin API. Metadata chooses the source and carries transport state. Ordinary track metadata does not contain rendered samples or measured FFT; CLIAMP's spectrum API and MPD's FIFO are separate capabilities. All four styles require PCM or a complete feature bundle; a partial feed must report unsupported styles until an approved source supplies the missing data.

| Source choice                           | Practical fit                                                                    | Boundary                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Auto Now Playing + manual app selection | Default player-agnostic model, including Kaset without a Kaset-only architecture | App identity is a hint. Resolve actual audio processes/helpers; manual selection must not broaden to a system mix.        |
| Player-provided PCM                     | Best optional route when a player already offers a feed, such as MPD             | Format, buffering, isolation, ownership, and synchronization still require validation.                                    |
| Player-provided features                | Avoid capture when features meet the selected style's requirements               | CLIAMP's reviewed export covers spectrum; mpv's configured stats can cover levels. Do not fabricate the missing features. |
| Core Audio process tap                  | First general macOS capture candidate for all four styles                        | Select only the bound music source, remain unmuted, and obtain system-audio consent.                                      |
| ScreenCaptureKit app audio              | Alternate application-filtered capture adapter                                   | Apple documents app-level audio filtering, not per-tab isolation or permission-free capture.                              |
| CAVA raw output                         | Optional comparison for an already configured source                             | Current native tap is global; not the default for the music-player-only requirement.                                      |

Apple's tap sample explicitly describes capturing “a process or group of processes” and says the first recording prompts for system-audio permission. Its ScreenCaptureKit talk says audio can be filtered “at an application level.” These support a general adapter model, not capture guarantees for every app/helper or protected stream. External-app capture still needs macOS authorization. A cooperative player feed avoids that capture path; it does not remove other security or configuration requirements. [A1] [A2] [A3]

The chosen presentation remains all four styles: spectrum, oscilloscope, mirrored spectrum, and stereo RMS/peak meters, optionally named “VU.” Supply time-domain data for the oscilloscope and preserve channel data before mono mixing. Use approximately 4–6 rows when space permits and an honest compact presentation. Keep both L/R indications in a compact stereo meter; CLIAMP's one-row Stereo branch displays only L, so do not copy that behavior unchanged. Style changes should reuse the source and analysis service, not restart capture. [C13]

For arbitrary existing players, the first experiment is source binding and isolation with explicit consent. For users already playing through CLIAMP or MPD, a negotiated feed adapter is a useful additional route. Neither route requires building a replacement player. The detailed capture, permission, packaging, and acceptance-test plan remains in the [capture report](music-audio-visualization-research.md).

## Reuse and licenses

| Candidate                    | Primary license evidence                                                                                                                                                    | Reuse implication                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLIAMP FFT/rendering samples | Its top-level MIT license requires its copyright and permission notice in copies or substantial portions.                                                                   | A small attributed port is a candidate. Its handwritten FFT does not require FFTW. CLIAMP's full player has Beep/Oto, codec, service, and optional external-tool dependencies; review those separately before embedding or distributing them. [L1] [C3] [C4] |
| ncmpcpp/MPD implementation   | Visualizer header and MPD FIFO file identify GPL-2.0-or-later.                                                                                                              | Use the feed architecture as a reference; do not present copied implementation as MIT code. [N1] [N3]                                                                                                                                                        |
| mpv/FFmpeg implementation    | mpv defaults to GPL-2.0-or-later; its copyright file describes an LGPL build subset and dependency limits. The inspected FFmpeg waveform file identifies LGPL-2.1-or-later. | Inspect exact files and build dependencies before code reuse or binary distribution. A filter graph is not permission to copy implementation under MIT. [L2] [M3]                                                                                            |
| CAVA/cavacore                | CAVA's own code has an MIT license. `cavacore.c` calls FFTW; FFTW documents GPL-2.0-or-later or a separately purchased alternative license.                                 | An isolated MIT rendering sample differs from linking cavacore or bundling a complete binary. Do not call the full dependency chain MIT. [L3] [L4] [V4]                                                                                                      |

These are license facts and review boundaries, not a legal conclusion about every possible distribution. No third-party implementation code was copied into this repository.

## Verification scope

Verified by reading pinned primary source and first-party documentation: sample origin, analysis branches, reviewed export contracts, waveform distinctions, macOS consent statements, and license declarations. Context7 helped locate docs; the pinned source owns the implementation claims.

Untested: compilation, runtime feed consumption, waveform quality, audio timing, app isolation, permissions, protected playback, device changes, and performance. No audio experiments were run.

Workspace checks were blocked in the dependency-free research clone. After integration, main-checkout workspace lint and all seven project type-check targets passed; Nx reused matching cached type-check results. No production code or dependencies changed.

Documentation checks passed: Prettier checked the report, Glow rendered it at 120 columns, and all 36 citation targets resolved. GitHub checks used pinned raw files and validated line ranges; Apple's sample used DocC JSON. The local capture-report link resolves in the integrated checkout. Terminal rendering does not verify website CSS or interaction behavior.

## Primary citations

- [C1] — CLIAMP `player/player.go:28–36, 285–303`: playback chain and tap placement.
- [C2] — `player/tap.go:50–135`: pass-through stereo ring, mono/stereo reads, audible-position sampling.
- [C3] — CLIAMP `go.mod:12,42` and Beep `speaker/speaker.go:35–65,97–101`: dependency versions and Oto output.
- [C4] — `ui/vis_analyze.go:157–250`, `ui/fft.go:5–41`, `ui/visualizer.go:5–10`: raw-buffer retention, Hann/FFT/band conversion, defaults.
- [C5] — `ui/vis_registry.go:54–88`, `ui/vis_classic_peak.go:9–11,66–73`, `ui/vis_driver.go:158–177`: mode inputs/specs and band updates.
- [C6] — `ui/model/tick.go:72–135`: sample selection, optional volume linking, stereo mono handling.
- [C7] — `docs/remote-control.md:5–7,43–50,215–220,241–252`; `ipc/stream.go:28–80`; `ui/model/ipc_runtime.go:624–696,763–774`; `ipc/protocol.go:34–68`: documented export and actual response construction.
- [C8] — `docs/plugins.md:160–214,670–708`, `luaplugin/visualizer.go:114–138`: Lua bands and publish contracts.
- [C9] — `luaplugin/api_http.go:17–60,65–110`: HTTP client and blocked destinations.
- [C10] — `player/engine.go:63–67`: in-process sample interface.
- [C11] — `ui/vis_wave.go:16–40`: point-sampled PCM trace.
- [C12] — `ui/vis_scope.go:5–34`: animated mono-delay XY scope.
- [C13] — `ui/vis_stereo.go:38–73,110–184`: compact L-only branch and L/R RMS/peak calculation.
- [C14] — `ui/vis_retro.go:91–114`: spectrum-interpolated horizon curve.
- [C15] — `ui/model/ipc_runtime.go:763–774`: actual spectrum response, including headless refresh behavior.
- [C16] — `ui/vis_driver.go:158–177`: raw-sample modes refresh samples without assigning spectrum bands.
- [N1] — MPD `doc/plugins.rst:1018–1030`, `doc/user.rst:471–504`, `src/output/plugins/FifoOutputPlugin.cxx:1,191–215`: public FIFO contract, multiple outputs, raw-byte writer.
- [N2] — ncmpcpp `doc/config:44–105`: MPD/Mopidy feeds, required format, timing warning, modes, FFTW prerequisite.
- [N3] — `src/screens/visualizer.cpp:1–18,151–235,250–352,401–415,433–447,641–655,818–868`: license, PCM read/channel split, time drawing, stereo XY, FFT and window.
- [M1] — mpv `DOCS/man/options.rst:8490–8539`: selected-track graph labels, `asplit`, and official `showvolume` example.
- [M2] — `filters/f_lavfi.c:473–481,635–655`: audio format and AVFrame input to libavfilter.
- [M3] — FFmpeg `libavfilter/avf_showwaves.c:6–18,180–183,690–741`; `avf_showspectrum.c:478–485,1142,1209–1227,1304–1319`: license, sample drawing, windowed FFT and magnitude output.
- [M4] — mpv `DOCS/man/input.rst:2590–2602`, `DOCS/man/ipc.rst:1–17,267–285`: filter metadata and local property observation.
- [M5] — FFmpeg `libavfilter/af_astats.c:122–125,554–557,732–748`: metadata/reset controls, channel RMS/peak keys, pass-through frames.
- [M6] — FFmpeg `libavfilter/avf_showspectrum.c:478–485,1209–1227,1304–1319`: windowed FFT and image-magnitude calculation.
- [V1] — CAVA `README.md:52,545–569,736–738`: aesthetic scope, native tap availability, raw output.
- [V2] — `input/coreaudio_tap.m:92–123,300–312,356,400`: private-TCC preflight, global tap, unmuted aggregate capture. Private preflight is not a public production permission API.
- [V3] — `cava.c:1304–1344`; `output/raw.c:19–69`; `example_files/config:164–166,203–207,273–274`: separate sample path, display scaling, raw binary/ASCII framing.
- [V4] — `cavacore.c:143–173,380–395`: FFTW dependency and transforms.
- [A1] — Apple, _Capturing system audio with Core Audio taps_: process/group samples, macOS 14.2 setup, purpose string, system-audio prompt. Read through its DocC JSON.
- [A2] — Apple WWDC22, _Meet ScreenCaptureKit_, at approximately 7:36: application-level audio filtering.
- [A3] — Apple macOS 26 guide: permission can cover screen/audio or audio only.
- [L1] — CLIAMP `LICENSE:3–13`: MIT notice requirements; `go.mod` lists its separate dependencies.
- [L2] — mpv `Copyright:3–25,76–78`: default license, optional LGPL subset, linked-library qualification.
- [L3] — CAVA `LICENSE:1–11`: MIT notice requirements.
- [L4] — FFTW first-party _License and Copyright_: GPL-2.0-or-later and alternative commercial terms.

[C1]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/player/player.go#L28-L36
[C2]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/player/tap.go#L50-L135
[C3]: https://github.com/gopxl/beep/blob/e2b0015c40fc5a25cd7b2705004274359b2c422b/speaker/speaker.go#L35-L65
[C4]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/ui/vis_analyze.go#L157-L250
[C5]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/ui/vis_registry.go#L54-L88
[C6]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/ui/model/tick.go#L72-L135
[C7]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/docs/remote-control.md#L215-L220
[C8]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/docs/plugins.md#L670-L708
[C9]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/luaplugin/api_http.go#L17-L60
[C10]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/player/engine.go#L63-L67
[C11]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/ui/vis_wave.go#L16-L40
[C12]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/ui/vis_scope.go#L5-L34
[C13]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/ui/vis_stereo.go#L157-L184
[C14]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/ui/vis_retro.go#L91-L114
[C15]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/ui/model/ipc_runtime.go#L763-L774
[C16]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/ui/vis_driver.go#L158-L177
[N1]: https://github.com/MusicPlayerDaemon/MPD/blob/a6664887665a3b39ea326a70da5afa4b5c6594c5/doc/plugins.rst#L1018-L1030
[N2]: https://github.com/ncmpcpp/ncmpcpp/blob/84fc45f0cc4f5bdf8b350fc22bfa6cc1392a52e4/doc/config#L44-L105
[N3]: https://github.com/ncmpcpp/ncmpcpp/blob/84fc45f0cc4f5bdf8b350fc22bfa6cc1392a52e4/src/screens/visualizer.cpp#L151-L235
[M1]: https://github.com/mpv-player/mpv/blob/413ff0b1cd4585294803308a1a14be2fad30cede/DOCS/man/options.rst#L8490-L8539
[M2]: https://github.com/mpv-player/mpv/blob/413ff0b1cd4585294803308a1a14be2fad30cede/filters/f_lavfi.c#L635-L655
[M3]: https://github.com/FFmpeg/FFmpeg/blob/5a23ac8460a7bc1c2cdbf6ac62bd67e023451b8f/libavfilter/avf_showwaves.c#L690-L741
[M4]: https://github.com/mpv-player/mpv/blob/413ff0b1cd4585294803308a1a14be2fad30cede/DOCS/man/input.rst#L2590-L2602
[M5]: https://github.com/FFmpeg/FFmpeg/blob/5a23ac8460a7bc1c2cdbf6ac62bd67e023451b8f/libavfilter/af_astats.c#L554-L557
[M6]: https://github.com/FFmpeg/FFmpeg/blob/5a23ac8460a7bc1c2cdbf6ac62bd67e023451b8f/libavfilter/avf_showspectrum.c#L478-L485
[V1]: https://github.com/karlstav/cava/blob/299219826379e137f0f4c48bfdc96019360964ec/README.md#L545-L569
[V2]: https://github.com/karlstav/cava/blob/299219826379e137f0f4c48bfdc96019360964ec/input/coreaudio_tap.m#L92-L123
[V3]: https://github.com/karlstav/cava/blob/299219826379e137f0f4c48bfdc96019360964ec/cava.c#L1304-L1344
[V4]: https://github.com/karlstav/cava/blob/299219826379e137f0f4c48bfdc96019360964ec/cavacore.c#L380-L395
[A1]: https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps
[A2]: https://developer.apple.com/videos/play/wwdc2022/10156/
[A3]: https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/26/mac/26
[L1]: https://github.com/bjarneo/cliamp/blob/9d9e55abd5ba87e1c8de4f9bd3ecc911d0f35b16/LICENSE#L3-L13
[L2]: https://github.com/mpv-player/mpv/blob/413ff0b1cd4585294803308a1a14be2fad30cede/Copyright#L3-L25
[L3]: https://github.com/karlstav/cava/blob/299219826379e137f0f4c48bfdc96019360964ec/LICENSE#L1-L11
[L4]: https://www.fftw.org/doc/License-and-Copyright.html
