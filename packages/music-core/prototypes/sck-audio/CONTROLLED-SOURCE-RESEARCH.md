# Which controlled sources can unchanged Kaset play?

Research checked on 2026-10-11. No playback, account access, upload, protected discovery, capture, or permission change occurred.

The reviewed source provides no supported route for playing a generated local tone directly in Kaset. It supports remote YouTube Music tracks, existing uploaded songs, and regular YouTube videos. An existing remote tone could supply a test signal, but its decoded output needs measurement before it can satisfy the [isolation protocol](ISOLATION-PROTOCOL.md). No suitable existing asset was identified in this research.

A narrower Safari-only exclusion case does not need a Kaset marker. It can test unrelated-source leakage while Kaset is silent. It cannot establish simultaneous isolation or Kaset admission.

## Installed version and source provenance

Read-only inspection of `/Applications/Kaset.app/Contents/Info.plist` reported version `0.14.1`, build `26`, and only the `kaset` URL scheme.

The upstream [v0.14.1 tag reference](https://api.github.com/repos/sozercan/kaset/git/ref/tags/v0.14.1) resolves directly to commit `1cf9a1a021341a8ee2a0c82f26be2633db8a1c98`. The [release](https://github.com/sozercan/kaset/releases/tag/v0.14.1) was published on 2026-09-24. Every source link below pins that commit rather than current `main`.

The tagged [release workflow](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/.github/workflows/release.yml#L185) sets the marketing version from the release tag and the build number from its workflow run. These fields describe a version; they do not prove installed binary provenance. This research did not compare the installed app with the release DMG or establish a reproducible build. The [existing application profile](APPLICATION-TARGETING.md#two-identities-with-different-roles) pins the local signed build independently. Supported behavior in the tagged source remains source evidence, not a live test of that installation.

## Supported media routes

The pinned [URL parser](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Services/URLHandler.swift) recognizes YouTube Music URLs, regular YouTube watch URLs, and `kaset` routes. It has no local-file, arbitrary HTTP media, or data-URL route. A media ID becomes a query value in a remote player URL; supplying a local path as that ID does not create a local-media route.

The [application router](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/KasetApp.swift#L801) sends Music song IDs to `PlayerService`. Regular YouTube video IDs switch the app to its separate YouTube source. Playlist, album, and artist URLs are parsed but do not start playback through this external router. The pinned [URL documentation](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/docs/url-scheme.md) describes these public routes.

The [Music player](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Views/MiniPlayerWebView.swift#L1349) constructs `https://music.youtube.com/watch` URLs. The [YouTube player](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Views/YouTube/YouTubeWatchWebView%2BDocumentGeneration.swift#L236) constructs `https://www.youtube.com/watch` URLs. Source searches found no local-media importer or playback file loader. These checks support a bounded conclusion: the reviewed playback paths cannot directly load the proposed local 997 Hz asset.

Kaset's [Library view](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Views/LibraryView.swift#L239) exposes an uploaded-songs collection. Its [API notes](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/docs/api-discovery.md#uploaded-songs-femusic_library_privately_owned_tracks) describe authenticated uploaded-track retrieval. This establishes a source-level route for existing uploads. It does not establish that this account contains one or that a particular upload plays in the installed app.

Google documents uploading personal audio on the YouTube Music website and playing it from the owner's library. Only the owner can play those uploads. Creating a new upload would write account data, which this preparation did not authorize or perform. An already uploaded user-owned asset avoids a new upload, but still needs user selection and later approved playback. [YouTube Music upload documentation](https://support.google.com/youtubemusic/answer/9716522?hl=en).

## Alternatives and evidence limits

The assessments below are experimental design inferences. They do not report a live result or authorize another attempt.

| Candidate                       | What it can support                   | Remaining prerequisite                    |
| ------------------------------- | ------------------------------------- | ----------------------------------------- |
| New local 997 Hz tone           | Known original bytes.                 | A supported Kaset route remains absent.   |
| Existing user-owned tone upload | Music playback without a new upload.  | Identify the original and decoded signal. |
| Existing remote YouTube tone    | Marker through a documented route.    | Validate its decoded output and coverage. |
| Ordinary music with a reference | Independent Kaset admission evidence. | Declare criteria suitable for music.      |

A preexisting upload requires an asset the user already owns. Neither its original file nor a remote video's title establishes the decoded frequency, purity, channel layout, level, or duration. The independent reference must validate those properties during the relevant test.

A file hash identifies the original asset, not its decoded playback waveform. Google documents AAC and Opus quality tiers for YouTube Music; that documentation does not establish the codec or exact waveform delivered to Kaset. Treat decoded reference measurements as the relevant control, even when original bytes are known. [YouTube Music audio quality](https://support.google.com/youtubemusic/answer/9076559?hl=en).

Ordinary music can contain energy in the Safari marker band. Applying the current band-power threshold during simultaneous music playback could therefore reject Kaset's own content. An independently sampled positive music control helps establish admission, but does not remove that ambiguity. A different simultaneous analysis would need declared criteria and offline validation before replacing the current protocol.

Using regular YouTube also changes Kaset's player source. The live experiment must retain the existing application and witness checks for that source. A new renderer or ambiguous witness invalidates the current proof; the runner cannot silently select a replacement. This follows the [targeting contract](APPLICATION-TARGETING.md#verification-around-discovery-and-capture), not a claim that both players share one process.

## The smaller exclusion question

The first defensible exclusion question is: **does the Kaset application stream contain measurable Safari output while Kaset is silent?**

This case needs a known Safari signal, an independent simultaneous Safari reference, valid target measurements, aligned timing, and the existing identity and route checks. Compare against a declared silent baseline and leakage threshold. A missing or silent Safari reference makes exclusion inconclusive. No positive Kaset marker is necessary because this case makes no claim about admitting Kaset audio.

A passing result would establish exclusion only for that silent-target case and tested configuration. It would not establish behavior when both applications play, or rule out a target filter that always returns silence. A later independent Kaset admission case addresses the latter limitation.

The current controlled protocol is not runnable unchanged: its exact Kaset marker remains unresolved, and its independent references are unimplemented. Preparation can proceed with the analyzer, Safari asset, and narrower case design. The completed availability probe's allowance is spent; this research creates no new live allowance.
