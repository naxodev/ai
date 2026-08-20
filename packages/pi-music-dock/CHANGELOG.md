# Changelog

This file records the standalone `0.1.0` release. Later versions use generated [GitHub release notes](https://github.com/naxodev/ai/releases?q=pi-music-dock).

## [Unreleased]

### Added

- Responsive right-center music side panel overlay (plugin approximation; may cover transcript).
- Native artwork on the same reconnecting client (`native-artwork` capability) with local PNG/JPEG/GIF/WebP sniffing.
- Bounded iTunes catalog fallback when native art is missing, too large, unsupported, or fails (exact match + mzstatic allowlist).
- `/music-view` and `ctrl+alt+m` to toggle the panel; `/music-focus` plus Space/arrows/Escape while focused.

### Changed

- Refresh promptly for provider changes, retain bounded polling fallback, and clean up subscriptions on reload and shutdown.

### Fixed

- Reserve a stable compact artwork slot so asynchronous loading does not shift the centered panel.
- Center Kitty artwork inside both panel borders instead of painting over the left edge.
- Request catalog artwork as PNG and use exact catalog duration when provider metadata is sparse.

## [0.1.0] - 2026-08-06

### Added

- macOS Now Playing status with an animated waveform and clipped track details.
- Play, pause, next, and previous controls through shortcuts and slash commands.
- `media-control` support with a `nowplaying-cli` fallback.
- Pi package metadata for GitHub and npm installation.

[Unreleased]: https://github.com/naxodev/ai/compare/pi-music-dock@v0.1.0...HEAD
[0.1.0]: https://github.com/naxodev/ai/releases/tag/pi-music-dock@v0.1.0
