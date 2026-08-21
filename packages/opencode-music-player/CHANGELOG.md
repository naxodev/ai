# Changelog

This file records the initial package release. Later versions use generated [GitHub release notes](https://github.com/naxodev/ai/releases?q=opencode-music-player).

## [0.1.0] - 2026-08-20

### Added

- Initial macOS system Now Playing integration for the OpenCode 2 TUI.
- Playback controls, progress display, expandable details, and waveform visualization.

### Changed

- Move the player from the footer overlay into the OpenCode sidebar.
- Keep a responsive one-row music bar below the active route when the sidebar is collapsed.
- Simplify compact metadata from title and artist to title, truncated title, then playback marker as terminal width decreases.
- Display native album artwork in Kitty-compatible terminals with a true-color fallback elsewhere.
- Support native artwork through Herdr and tmux graphics passthrough.
- Resolve missing system artwork through exact iTunes catalog matches.
- Refresh promptly for provider changes, retain bounded polling fallback, and clean up subscriptions on plugin disposal.

### Fixed

- Re-anchor native album artwork and remove stale Kitty images when its sidebar slot moves or resizes.

[0.1.0]: https://github.com/naxodev/ai/releases/tag/opencode-music-player@v0.1.0
