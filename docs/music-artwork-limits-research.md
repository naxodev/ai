# Why native artwork limits rejected an ordinary album cover

Research baseline: `d9b7469a45ac9c996123ac667ba285b395e5e7c0` (`music-core` 0.1.5).

## Conclusion

Finite artwork limits are intentional. **No sizing justification was found for the exact 1 KiB default, 192 KiB ceiling, or 64 KiB frame limit.**

The documented goals are bounded allocation, bounded retained work, and isolation of playback and healthy clients from slow artwork requests. Those goals justify limits. They do not establish that 1 KiB is a useful production artwork budget. The 64 KiB session frame limit predates native artwork. None of these values is documented as an image-format or terminal requirement. [S1] [S2] [S3] [S4]

The reported native JPEG was 363,390 bytes. Its base64 representation needs 484,520 bytes before the response envelope. It exceeds all three original limits but fits the existing 1 MiB subprocess output cap. Host-side conversion produced a valid 147,336-byte PNG, but conversion happens after transport. [S6] [S7] [S9]

## What each original limit did

| Limit                             |          Baseline value | Purpose and evidence                                                                                      |
| --------------------------------- | ----------------------: | --------------------------------------------------------------------------------------------------------- |
| Native artwork default            |     1,024 decoded bytes | Bounds image retention and decoding. Introduced in `c56805db` without a sizing explanation.               |
| Native artwork schema ceiling     | 196,608 bytes (192 KiB) | Clamps configuration and validates wire data. Introduced in the same commit without a sizing explanation. |
| Daemon and client frame defaults  |   65,536 bytes (64 KiB) | Bound encoded messages and received NDJSON lines. Introduced before artwork in `c6dcecde`.                |
| Response envelope reserve         |               128 bytes | Source explicitly reserves space for the response, including a maximum safe request ID.                   |
| Provider metadata allowance       |             8,192 bytes | Bounds complete provider JSON before parsing, beyond artwork base64. No exact sizing explanation found.   |
| Subprocess output cap             | 1,048,576 bytes (1 MiB) | Bounds buffered stdout and stderr. Predates the daemon and matches Node's documented default.             |
| Provider metadata-stream line cap |            65,536 bytes | Bounds complete and partial stream lines. The stream explicitly excludes artwork.                         |

Sources: configuration, framing, provider, and runner [S6] [S7] [S8] [S9]; original patches [S1] [S2]; runner history [S10] [S11]; hardening [S5] [S12]; Node documentation [S13].

The metadata stream runs with `--no-artwork`. Native artwork uses a separate `media-control get --now` command. Increasing artwork transport limits does not require changing the metadata-stream cap. [S7] [S14]

## Historical evidence and research scope

1. The initial workspace already had the 1 MiB runner cap in Pi's media adapter. PR #34 moved the runner into `music-core`. Its description covers shared ownership and host neutrality, not size tuning. [S10] [S11]
2. Commit `c6dcecde` introduced 64 KiB session framing before artwork support within PR #52. [S2] [S3]
3. Commit `c56805db`, “centralize bounded artwork reads,” introduced the 1 KiB default, 192 KiB ceiling, response reserve, 32-entry capacity, and metadata allowance. Its comments explain finite allocation and response fit, not the chosen image sizes. [S1]
4. PR #52 documents identity checks, deduplication, finite queues, and isolation across 24 clients. Its live certification used one VLC item. That establishes lifecycle behavior, not representative cover sizes. [S3]
5. PR #95 hardens provider boundaries. Its follow-up applies the stream cap to complete lines as well as partial lines. It does not justify artwork sizes. [S5] [S12]

The research covered source, the architecture guide, merged history, original commit patches, PRs #34, #35, #52, and #95, and artwork issues #127, #129, #140, and #145. Relevant PR comment and review endpoints contained no sizing discussion. History searches found only the original introduction of the 1 KiB default and 192 KiB ceiling.

This supports **“no rationale found in the reviewed primary sources.”** It does not prove there was no private discussion. It also does not establish that 1 KiB was a typo or a test-fixture value. The test that pinned this default did not explain its suitability. [S16]

## Base64 and subprocess budgets

The configuration derives the effective native limit from the requested image limit, schema ceiling, and frame budget. It then verifies the complete response fits. [S6]

```text
encodedBytes(n) = 4 × ceil(n / 3)
frameArtworkMaxBytes = floor((maxFrameBytes - 128) × 0.75)
effectiveNativeMax = min(requestedNativeMax, schemaCeiling, frameArtworkMaxBytes)
require encodedBytes(effectiveNativeMax) + 128 <= maxFrameBytes
```

| Image bytes                            | Base64 bytes | Including the 128-byte reserve |
| -------------------------------------- | -----------: | -----------------------------: |
| 1,024: original default                |        1,368 |                          1,496 |
| 49,056: original frame-derived maximum |       65,408 |                         65,536 |
| 147,336: converted PNG                 |      196,448 |                        196,576 |
| 196,608: original hard ceiling         |      262,144 |                        262,272 |
| 363,390: reported native JPEG          |      484,520 |                        484,648 |
| 524,288: new 512 KiB budget            |      699,052 |                        699,180 |

Raising only one of the original limits cannot fix this image. A 512 KiB frame fits the reported JPEG, but cannot carry an arbitrary 512 KiB image after base64 expansion.

The provider first buffers command output, then checks `encodedBytes(maxBytes) + 8192` before parsing JSON. Therefore, the native limit does not prevent subprocess allocation up to the independent 1 MiB cap. At the new 512 KiB image limit, the adapter's complete output allowance is 707,244 bytes. It fits the runner cap without changing command execution. Multi-megabyte artwork would require revisiting that boundary. [S7] [S9]

Node counts `maxBuffer` in bytes on stdout or stderr. Exceeding it terminates the process and truncates output. It is not an image-format restriction. [S13]

## Implemented decision

Increase the native default and schema ceiling to **512 KiB**, and the shared frame default to **768 KiB**. These values fit the observed JPEG with headroom and allow the full image budget after base64 expansion. They are an explicit bounded policy, not a measured optimum across all music applications.

The response shape and protocol revision remain compatible. Larger responses require the additive `native-artwork-512k` capability. Clients with a custom frame limit below 768 KiB do not advertise it. Older peers receive `too-large` when artwork cannot fit their original 64 KiB response budget; transport commands remain usable. Shared playback snapshots retain their 64 KiB bound because every peer receives them.

This compatibility check is necessary because original clients enforce their own frame limits, and the original hello does not negotiate payload sizes. [S20] [S21]

The schema also checks decoded byte length. A base64 character limit alone can admit one extra byte at this new boundary because base64 rounds in groups of three.

### Memory tradeoff

The coordinator retains up to 32 settled or in-flight recording identities. Available results enter its cache; equal requests share acquisition. [S18]

- Original default: up to 43,776 base64 characters across 32 covers.
- New limit: up to 22,369,664 characters, about 21.33 MiB as ASCII bytes.
- The 64-frame mandatory queue has a configured encoded-payload upper bound of 48 MiB per connection at 768 KiB per frame, versus 4 MiB originally.

These are conservative payload counts, not measured heap peaks. Provider JSON, validation, serialized responses, socket buffers, and host decoding add allocations. The queue is bounded and a slow client remains connection-local. The larger budget is limited to half-megabyte images rather than adopting the hosts' multi-megabyte download allowance. [S17] [S18] [S19]

### Host behavior and activation

Both daemon and client code must be updated for larger native artwork. A running old daemon still uses its original limits. This repository change does not update the installed OpenCode plugin or restart the shared daemon.

OpenCode converts native JPEG into PNG locally. Pi's existing native path accepts PNG and falls back to the catalog for JPEG. Raising transport limits does not change that Pi restriction. [S15] [S22]

Catalog matching remains a separate constraint. It preserves accents and requires known durations to match within 1,000 ms. The reported catalog response used `Yamandu` instead of `Yamandú` and differed by 1,873 ms. Issue #129 explicitly requires strict matching; relaxing recording identity is not needed to transport valid native artwork. [S23] [S24]

## Verification scope

Historical claims come from read-only source and GitHub queries. The byte budgets were checked with Bun arithmetic. The initial live investigation established the JPEG size and successful host conversion; the background historical research did not repeat that observation.

The regression test uses synthetic bytes with the exact reported size, through the actual socket server and client. It verifies delivery to updated clients, safe fallback for older and smaller-frame clients, shared acquisition, and working playback commands. A separate schema test checks the full 512 KiB boundary and rejects the next decoded byte.

## Primary sources

- [Original artwork-limit implementation][S1] and [earlier frame defaults][S2].
- [Shared-session design and verification, PR #52][S3].
- [Provider boundary hardening, PR #95][S5].
- [Node's subprocess output contract][S13].

[S1]: https://github.com/naxodev/ai/commit/c56805db7a61163c61e494e7c59640581a9348c5
[S2]: https://github.com/naxodev/ai/commit/c6dcecde714638248c48dbf89a67bd380455a33c
[S3]: https://github.com/naxodev/ai/pull/52
[S4]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/docs/music-session-architecture.html#L1008-L1033
[S5]: https://github.com/naxodev/ai/pull/95
[S6]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/session/config.ts#L16-L323
[S7]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/system-media.ts#L742-L802
[S8]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/session/framing.ts#L9-L79
[S9]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/run.ts#L1-L145
[S10]: https://github.com/naxodev/ai/blob/9159b718dda8dfd38be8f6ba7c65d9aa9b1b0e26/packages/pi-music-dock/extensions/music-dock/media.ts#L59
[S11]: https://github.com/naxodev/ai/pull/34
[S12]: https://github.com/naxodev/ai/commit/5193a39af0c597251ac138c85726cf16ca413d69
[S13]: https://nodejs.org/docs/latest-v22.x/api/child_process.html#child_processexecfilefile-args-options-callback
[S14]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/system-media.ts#L262-L442
[S15]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/docs/music-session-architecture.html#L1087-L1118
[S16]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/tests/session-coordinator.test.ts#L104-L129
[S17]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/session/server.ts#L540-L678
[S18]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/session/coordinator.ts#L638-L778
[S19]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/session/protocol.ts#L139-L172
[S20]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/session/client.ts#L730-L748
[S21]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/session/protocol.ts#L206-L234
[S22]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/pi-music-dock/extensions/music-dock/artwork.ts#L297-L319
[S23]: https://github.com/naxodev/ai/blob/d9b7469a45ac9c996123ac667ba285b395e5e7c0/packages/music-core/catalog-artwork.ts#L20-L81
[S24]: https://github.com/naxodev/ai/issues/129
