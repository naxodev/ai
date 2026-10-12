# A controlled Kaset marker through personal uploads

Research checked on 2026-10-12 UTC. This report uses public documentation and the pinned Kaset source. It performs no account access, upload, playback, protected discovery, capture, or permission change.

**A personal FLAC upload is a supported YouTube Music route and a plausible unchanged-Kaset route. Installed playback remains unverified.** Prepare and validate the local asset offline first. Any upload needs separate approval because it writes audio and metadata to the owner's account.

The [completed Safari exclusion case](README.md#passing-paused-kaset-case-on-2026-10-12-utc) establishes the silent-target case only. It supplies no controlled Kaset marker or simultaneous isolation result.

## Upload contract

Google lists FLAC, M4A, MP3, OGG, and WMA uploads. WAV is absent from that list; treat WAV acceptance as unsupported. Uploads use the desktop website, either its file drop area or profile menu. They cannot use a Brand Account channel. Library appearance can lag successful upload. [YouTube Music upload documentation](https://support.google.com/youtubemusic/answer/9716522?hl=en).

That document states that only the owner can play an upload. Shared playlists do not grant access, including to family-plan members. Uploaded songs support background, ad-free, and offline playback without Premium. Casting, smart speakers, and Sonos require Premium. These are Google's service capabilities; they do not establish Kaset's offline or casting support. Google accepts associated metadata and artwork with the audio.

Use a generic filename and minimal test title. Omit personal names, account identifiers, paths, comments, and artwork from the proposed file. This minimizes submitted information; owner-only playback does not establish confidentiality from Google. Do not inspect account contents or create, replace, or delete an upload under offline preparation authority.

## Kaset's source route

The [v0.14.1 source](https://github.com/sozercan/kaset/tree/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98) pins commit `1cf9a1a021341a8ee2a0c82f26be2633db8a1c98`. The installed app previously reported `0.14.1`, build `26`. Matching version fields do not prove binary provenance; the [existing source research](CONTROLLED-SOURCE-RESEARCH.md#installed-version-and-source-provenance) records that limit.

- **Fetch:** `YTMusicClient.fetchUploadedSongsPlaylist()` browses `FEmusic_library_privately_owned_tracks`. A request failure returns no tile. The [client](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Services/API/YTMusicClient.swift#L893) and [API notes](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/docs/api-discovery.md#uploaded-songs-femusic_library_privately_owned_tracks) describe authenticated retrieval.
- **Represent:** the [library parser](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Services/API/Parsers/LibraryContentParser.swift#L272) creates a virtual playlist only when parsed tracks or a positive track count exist. The [track parser](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Services/API/Parsers/PlaylistParser.swift#L971) requires a video ID and creates ordinary `Song` values with playability metadata.
- **Select:** [Library → Uploads](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Views/LibraryView.swift#L482) opens that playlist. The [row action](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Views/PlaylistDetailView.swift#L512) rejects an unplayable selection, begins a Music playback intent, and calls `PlayerService.playQueue()`.
- **Play:** the [queue](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Services/Player/PlayerService%2BQueue.swift#L33) passes the selected song to Music playback. The [playback service](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Services/Player/PlayerService%2BPlaybackControls.swift#L341) loads its video ID through `SingletonPlayerWebView`. The [Music URL builder](https://github.com/sozercan/kaset/blob/1cf9a1a021341a8ee2a0c82f26be2633db8a1c98/Sources/Kaset/Views/MiniPlayerWebView.swift#L1349) targets `https://music.youtube.com/watch`.

**Inference:** selecting an uploaded row follows the normal Music player path, avoiding the separate regular-YouTube player route. It therefore fits the current witness assumptions better. Source routing does not guarantee reuse of the same WebKit process. The existing [application and witness guards](APPLICATION-TARGETING.md#verification-around-discovery-and-capture) must still pass; never replace a missing or changed witness automatically.

No suitable upload has been identified. This research does not prove that this account can upload, Kaset can list the result, or the installed binary can play it. An absent tile can mean empty content, parsing failure, or a failed request. It cannot establish an empty account.

## Original asset and decoded control

The [prepared FLAC](KASET-CONTROLLED-ASSET.md) contains integer PCM at 48 kHz, two identical channels, and a 997 Hz sine near 0.1 peak. Its bit depth, quantization rule, duration, generic metadata, file SHA-256, and decoded PCM checks are recorded. WAV files serve only as local intermediates. FLAC preserves its encoded integer PCM losslessly; its format supports audio metadata and pictures. [FLAC specification, sections 3 and 8](https://www.rfc-editor.org/rfc/rfc9639.html#section-3).

Offline verification should decode the final FLAC and check exact sample count, channel equality, peak, marker power, purity, and the other marker band. Quantized PCM approximates the ideal sine; record the actual decoded values. This checks the submitted file only.

Google documents AAC and Opus streaming quality tiers. It does not promise delivery of original FLAC samples to Kaset. The upload documentation also provides no bit-exact playback guarantee. The actual upload codec, server processing, resampling, gain, and decoded waveform remain unknown. [YouTube Music audio quality](https://support.google.com/youtubemusic/answer/9076559?hl=en).

Consequently, an original file hash cannot validate a later captured reference. The [isolation protocol](ISOLATION-PROTOCOL.md#freeze-numerical-analysis-and-timing) still requires an independent positive Kaset reference in every evaluated window. Keep its declared thresholds; do not relax them after hearing or measuring an upload.

## Next decision

The offline generator, independent decoder checks, and metadata review are complete. The [source guide](KASET-CONTROLLED-ASSET.md#proposed-upload-only-step) presents the exact file and hashes. The [protocol](ISOLATION-PROTOCOL.md#prepare-controlled-sources-and-references) excludes uploads within the capture campaign and describes this separate preparation proposal. One owner upload still needs explicit account-write approval identifying the submitted audio and metadata. Prefer a manual upload by Nacho through the supported website.

After separate authorization, check that the uploaded row appears in Kaset's Music library and can play without changing the installation. Playback, witness verification, capture references, and any permission setup need their own reviewed scope. Keep simultaneous isolation blocked until those controls exist.
