# @naxodev/opencode-music-player

A sidebar player for the OpenCode 2 TUI that displays and controls the active macOS system media session.

It supports browsers, Spotify, Apple Music, Kaset, and other apps exposed through [`media-control`](https://github.com/ungive/media-control). The player keeps the existing OpenCode theme and provides keyboard and mouse controls.

## Artwork

The player reads embedded artwork from `media-control` when the active app publishes it. When artwork is missing, it sends the track title, artist, and album to the public iTunes Search API and downloads an exact match from Apple's image CDN.

Ghostty and other terminals with Kitty graphics support display the cover as a native image. Other terminals receive a true-color half-block rendering of the same cover.

Terminal multiplexers must pass Kitty graphics through to use native images. The player uses the half-block rendering when the host does not expose that support.

Herdr users can enable its experimental renderer in `~/.config/herdr/config.toml`:

```toml
[experimental]
kitty_graphics = true
```

tmux 3.3 and later users must allow wrapped graphics passthrough in `~/.tmux.conf`:

```tmux
set -g allow-passthrough on
```

> [!IMPORTANT]
> This package targets the beta OpenCode 2 TUI plugin API in `opencode2 v0.0.0-next-16927`. OpenCode may change this API before its stable release.

## Requirements

- macOS
- OpenCode 2 `v0.0.0-next-16927`
- Bun, which OpenCode uses to load TypeScript plugin packages
- [`media-control`](https://github.com/ungive/media-control), recommended:

  ```sh
  brew tap ungive/media-control
  brew install media-control
  ```

[`nowplaying-cli`](https://github.com/kirtan-shah/nowplaying-cli) is a fallback. Its play state can freeze for some media apps.

## Install

Add the package to the `plugin` array in your global `~/.config/opencode/tui.jsonc` or project `.opencode/tui.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@naxodev/opencode-music-player"],
}
```

OpenCode installs npm plugin packages and their production dependencies in its isolated cache. Restart OpenCode after changing the package entry.

### Local checkout

OpenCode imports local packages directly and does not install their dependencies. Install them first:

```sh
git clone https://github.com/naxodev/ai.git
cd ai
bun install --frozen-lockfile
```

Then reference the absolute package path:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/ai/packages/opencode-music-player"],
}
```

## Verify

Start OpenCode and list active plugin IDs:

```sh
opencode2 api get /api/plugin
```

The response should include `music-player`. If it does not, inspect `~/.local/share/opencode/log/opencode.log` for package resolution or setup errors.

## Controls

| Input              | Action         |
| ------------------ | -------------- |
| `ctrl+shift+p`     | Play or pause  |
| `ctrl+shift+left`  | Previous track |
| `ctrl+shift+right` | Next track     |

## Development

```sh
bun install --frozen-lockfile
bun run check
```

The workspace check verifies formatting, types, tests, and npm package contents for both packages. See the workspace [contribution guide](../../CONTRIBUTING.md) for the contribution and release process.

## Community

- Ask usage questions in [GitHub Discussions](https://github.com/naxodev/ai/discussions).
- Report reproducible bugs with the [bug form](https://github.com/naxodev/ai/issues/new?template=bug.yml).
- Read [SUPPORT.md](SUPPORT.md) before requesting support.
- Report vulnerabilities privately as described in the workspace [security policy](../../SECURITY.md).

## License

[MIT](LICENSE)
