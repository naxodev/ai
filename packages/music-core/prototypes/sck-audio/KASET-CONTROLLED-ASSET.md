# Prepare the controlled Kaset source

The local file `kaset-997hz-control-30s.flac` is prepared and verified. It contains a generated 997 Hz control tone. It has not been uploaded, played in Kaset, or used in capture. Its local decoded waveform is known; its eventual streamed waveform remains unknown.

The [route research](KASET-CONTROLLED-ASSET-ROUTE.md) identifies a personal YouTube Music upload as a supported service route and a plausible unchanged-Kaset route. The pinned source sends uploaded rows through the Music player. This is source evidence, not verified playback in the installed app. The [passing Safari case](README.md#passing-paused-kaset-case-on-2026-10-12-utc) does not establish Kaset admission.

## Fixed source and generated files

| Property           | Prepared value                                                     |
| ------------------ | ------------------------------------------------------------------ |
| Filename           | `kaset-997hz-control-30s.flac`                                     |
| Title tag          | `Kaset 997 Hz control`                                             |
| Frequency          | `997 Hz`                                                           |
| Sample rate        | `48000 Hz`                                                         |
| Channels           | Two identical channels                                             |
| PCM representation | Signed 24-bit integer                                              |
| Original duration  | `30 seconds`, or `1440000` stereo frames                           |
| Ideal peak         | `0.1`                                                              |
| Quantization       | `Math.round(sample * 2^23)`                                        |
| File bytes         | `1319898`                                                          |
| File SHA-256       | `4bfcc9069ff2ece73daf81095b7b14d2c8043fa9a82646d5b9ca70e4d9e34268` |

Thirty seconds gives later playback setup more headroom than a short source. It does not extend any capture allowance or establish the streamed duration. No fade, normalization, artwork, artist, account identifier, path, or personal comment is included. The only comment field is the generic title. The FLAC vendor is `ffmpeg`; its padding contains zeros.

The generator synthesizes one second of integer PCM and repeats it thirty times. Identical samples feed both channels. It writes a temporary WAV, encodes FLAC with installed FFmpeg, decodes that file independently with macOS `afconvert`, and requires exact PCM equality. It deletes the temporary WAV files. It keeps the FLAC, preparation manifest, and bounded aggregate verification in ignored `dist/controlled-kaset-source`.

Run the fixed preparation from the repository root:

```sh
bun packages/music-core/prototypes/sck-audio/build-kaset-control.ts
```

This macOS command needs the existing `/opt/homebrew/bin/ffmpeg` and `/usr/bin/afconvert`. It accepts no arguments and refuses an existing output directory before conversion. Preserve a reviewed file and its hashes before any separate preparation. Importing the builder starts no conversion or filesystem work. The command generates source files only; it accesses no account, browser, playback device, native capture helper, or permission service.

## Offline verification

The final file encoded with FFmpeg 9.0.2 and decoded with macOS `afconvert`. The independent decoded PCM matched the source exactly. A separate complete build reproduced the same file SHA-256. A second invocation stopped with `EEXIST` before conversion and left its file and manifest unchanged.

The validator checks the FLAC STREAMINFO fields and source PCM checksum, accepts only the reviewed generic metadata, and bounds input sizes. Those checks do not substitute for decoding. FLAC's PCM checksum uses the format's MD5 field; the full file is pinned separately by SHA-256. [FLAC STREAMINFO and metadata specification](https://www.rfc-editor.org/rfc/rfc9639.html#section-8.2).

Every 100 ms window passed the local marker checks. The validator uses a periodic Hann transform over bins 97–102 for the Kaset band and 209–214 for the Safari band. Its marker purity uses Hann-weighted power normalization. A separate rising-crossing count rejects substantial frequency changes, including a 1000 Hz tone inside the broad marker band. Counting over thirty seconds has a resolution of `1/30 Hz`; it cannot establish exact frequency by itself. Fixed waveform generation and byte-exact decoded PCM comparison define the source identity. The file's peak tolerance is one 24-bit quantization step.

| Decoded measurement        | Result                  |
| -------------------------- | ----------------------- |
| Complete 100 ms windows    | `300`                   |
| Rising-crossing rate       | `997 Hz`                |
| Peak                       | `0.10000002384185791`   |
| Mean power                 | `0.005000000007014526`  |
| Minimum Kaset marker power | `0.004999601263524999`  |
| Minimum marker purity      | `0.999920283065951`     |
| Maximum Safari-band power  | `7.369864344955565e-16` |
| Channel difference         | `0`                     |

The measured peak differs slightly from the ideal value because integer PCM quantizes the sine. These measurements describe the local file. Google processing, playback gain, codec choice, resampling, and decoded output in Kaset remain unverified. The live procedure still needs its independent positive reference in every evaluated window.

Ten focused tests cover wrong in-band frequency, Safari contamination that otherwise preserves level and purity, opposite channels, a silent final window, changed rate or duration, lossless sample identity, metadata privacy, source checksum, import safety, and rejected CLI arguments. The actual converter and independent decoder were also exercised in a temporary directory. Native decoding failed inside the command sandbox and passed outside it with the same file and arguments; validation was not weakened.

## Proposed upload-only step

This is a separate source-preparation proposal, not a live capture attempt. The [isolation protocol](ISOLATION-PROTOCOL.md#prepare-controlled-sources-and-references) excludes uploads within its capture campaign. The proposed exception requires explicit approval for **one identified owner upload** before changing account data.

The proposed write is the exact FLAC above, including its generic title, to the personal YouTube Music library Nacho uses with Kaset. Google lists FLAC uploads and owner-only playback. [YouTube Music upload documentation](https://support.google.com/youtubemusic/answer/9716522?hl=en). The route report records account restrictions and playback limits. The proposal includes no replacement or deletion of existing tracks.

After that approval, Nacho can upload the reviewed file manually through the supported website. A successful upload would establish account acceptance only. The next separate step would check its appearance in Kaset's **Library → Uploads**, followed by separately approved playback and source verification. Missing or changed application/witness proof must stop validation without a replacement.

All three paired-probe allowances are spent. This file creates no playback, registration, permission-reset, or capture allowance. The Kaset independent reference, cross-framework timing, physical-route observation, full four-case isolation campaign, and permission/distribution gates remain open.
