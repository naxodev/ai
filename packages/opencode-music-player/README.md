# `@naxodev/opencode-music-player`

<p align="center">
  <img src="https://raw.githubusercontent.com/naxodev/ai/main/docs/media/opencode-music-player/sidebar.png" alt="OpenCode sidebar player showing Wrecked by Kiasmos with artwork, waveform, seek bar, and transport" width="340" />
</p>

[![npm](https://img.shields.io/npm/v/@naxodev/opencode-music-player)](https://www.npmjs.com/package/@naxodev/opencode-music-player)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A sidebar player and compact bottom bar for the OpenCode 2 TUI that display and control the active macOS system media session. Play something in Spotify, Apple Music, a browser — the sidebar follows, with album artwork, a live waveform, a clickable seek bar, and transport controls.

```jsonc
// ~/.config/opencode/cli.json (or .opencode/cli.json)
{
  "plugins": ["@naxodev/opencode-music-player"],
}
```

<p align="center">
  <img src="https://raw.githubusercontent.com/naxodev/ai/main/docs/media/opencode-music-player/compact.png" alt="Compact now-playing bar: pause marker, Wrecked - Kiasmos" width="640" />
</p>

## What you get

- **Sidebar player** — native album artwork (Kitty graphics in Ghostty, WezTerm, iTerm2; true-color half-blocks elsewhere), animated waveform, seek slider, elapsed/total time, and prev/pause/next.
- **Compact bar** — a one-row now-playing line below the active route whenever a track exists, visible even with the session sidebar collapsed. Click the marker to play/pause; click in the seek region to seek.
- **System-wide** — any app exposed through [`media-control`](https://github.com/ungive/media-control) works. Artwork failure never blocks playback state.
- **Shared daemon** — one machine-local music-session daemon serves every host, so OpenCode and Pi see the same state.

## Controls

| Input              | Action         |
| ------------------ | -------------- |
| `ctrl+shift+p`     | Play or pause  |
| `ctrl+shift+left`  | Previous track |
| `ctrl+shift+right` | Next track     |

The compact bar adapts to width: wide terminals show marker, title, and artist; medium terminals omit the artist; narrow terminals truncate the title, then keep only the marker.

## Requirements

- macOS
- OpenCode 2 `v0.0.0-next-17444`
- Bun, which OpenCode uses to load TypeScript plugin packages
- [`media-control`](https://github.com/ungive/media-control), recommended:

  ```sh
  brew tap ungive/media-control
  brew install media-control
  ```

[`nowplaying-cli`](https://github.com/kirtan-shah/nowplaying-cli) is a fallback. Its play state can freeze for some media apps.

> [!IMPORTANT]
> This package targets the beta OpenCode 2 TUI plugin API in `opencode2 v0.0.0-next-17444`. OpenCode may change this API before its stable release.

## Terminal graphics

Ghostty and other terminals with Kitty graphics display the cover as a native image. Other terminals receive a true-color half-block rendering of the same cover. Multiplexers must pass Kitty graphics through:

- Herdr — enable its experimental renderer in `~/.config/herdr/config.toml`:
  ```toml
  [experimental]
  kitty_graphics = true
  ```
- tmux 3.3+ — allow wrapped passthrough in `~/.tmux.conf`:
  ```tmux
  set -g allow-passthrough on
  ```

## Local checkout

OpenCode imports local packages directly and does not install their dependencies. Install them first:

```sh
git clone https://github.com/naxodev/ai.git
cd ai
bun install --frozen-lockfile
```

Then reference the absolute package path:

```jsonc
{
  "plugins": ["/absolute/path/to/ai/packages/opencode-music-player"],
}
```

## Verify

Start OpenCode and list active plugin IDs:

```sh
opencode2 api get /api/plugin
```

The response should include `music-player`. If it does not, inspect `~/.local/share/opencode/log/opencode.log` for package resolution or setup errors.

## Architecture

One reconnecting music-session client supplies replayed and live state, provider status, transport, and daemon-owned native artwork bytes. OpenCode keeps plugin lifecycle, the Solid compact and sidebar UI, optimistic transport presentation, seek coalescing, notifications, waveform projection, iTunes catalog fallback, and Kitty or half-block rendering locally. Plugin disposal removes its client; other clients keep the shared daemon alive.

Read the [music session architecture field guide](https://github.com/naxodev/ai/blob/main/docs/music-session-architecture.html) for the daemon protocol, replay, reconnect, and cleanup model.

## Community

- Ask usage questions in [GitHub Discussions](https://github.com/naxodev/ai/discussions).
- Report reproducible bugs with the [bug form](https://github.com/naxodev/ai/issues/new?template=bug.yml).
- Report vulnerabilities privately as described in the workspace [security policy](https://github.com/naxodev/ai/blob/main/SECURITY.md).

## License

[MIT](LICENSE)
