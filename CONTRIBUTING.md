# Contributing

Contributions are welcome. By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

This workspace requires macOS because both production packages invoke macOS media tools. Install Bun 1.3.7 and Node.js 22.19 or later.

```sh
git clone https://github.com/naxodev/ai.git
cd ai
bun install --frozen-lockfile
bun run check
```

Run one project's checks with `bunx nx run-many -t typecheck test format:check package:check smoke --projects=<project>`. The project names are `opencode-music-player` and `pi-music-dock`.

Keep changes focused and preserve each host integration contract. Add tests that explain why changed behavior matters. Use Conventional Commit messages, such as `fix(pi-music-dock): keep paused waveform still`.

## Releasing

The packages release independently. Nx derives versions from Conventional Commits, creates `<project>@v<version>` tags, pushes the release commit and tag, and creates GitHub releases with generated notes. No committed changelog update is required.

Preview every release before applying it:

```sh
bunx nx release --projects=<project> --skip-publish --dry-run
bunx nx release --projects=<project> --skip-publish
```

The pushed tag starts `.github/workflows/publish.yml`. CI checks out the exact tag, validates the project mapping and package manifest, runs all package gates, and publishes directly from `packages/<project>`. Stable versions use the npm `latest` dist-tag. Prereleases use `next`.

Re-run an existing tag with:

```sh
gh workflow run publish.yml -f tag=<project>@vX.Y.Z
```

The workflow is idempotent. It succeeds without republishing when the exact package version already exists.

### Trusted publishing

After each package exists on npm, configure its npm Trusted Publisher with:

- Organization or user: `naxodev`
- Repository: `ai`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Allowed actions: `npm publish`

Do not configure an npm token. The workflow uses npm 11, OIDC trusted publishing, and provenance. The GitHub `production` environment protects production runs, but the npm trusted publisher environment field remains blank. npm trusted publishers created after May 20, 2026 require at least one allowed action.

### First publication

npm does not allow trusted publisher configuration before a package exists. Neither package exists yet, so a maintainer must bootstrap version `0.1.0` once from each package directory with an interactive npm account and 2FA:

```sh
bun run check
cd packages/opencode-music-player
npm publish --access public --provenance=false
cd ../pi-music-dock
npm publish --access public --provenance=false
```

Configure both trusted publishers immediately afterward. Every later release uses OIDC and includes provenance.

Create the initial release tags on the bootstrap commit so future Nx releases have a version baseline:

```sh
git tag -a opencode-music-player@v0.1.0 -m "opencode-music-player@v0.1.0"
git tag -a pi-music-dock@v0.1.0 -m "pi-music-dock@v0.1.0"
git push origin opencode-music-player@v0.1.0 pi-music-dock@v0.1.0
```

These tag-triggered workflow runs are safe after the manual publications because their registry checks skip existing versions.

### Verification

```sh
npm view @naxodev/<package> version
npm view @naxodev/<package> dist-tags
npm view @naxodev/<package>@<version> --json
```

Do not automate removal of stale npm dist-tags. A maintainer should correct dist-tags manually if a back-patch would move `latest` to an older release line.
