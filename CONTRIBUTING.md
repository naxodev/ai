# Contributing

Contributions are welcome. By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

Install Git, Bun 1.3.7, and Node.js 22.19 or later with npm available on `PATH`. Run the setup commands in Bash on macOS/Linux or PowerShell on Windows:

```sh
git clone https://github.com/naxodev/ai.git
cd ai
bun install --frozen-lockfile
```

Run the following shared checks from the repository root on any of those platforms:

```sh
bun run compatibility:check
bun run security:check
bun run format:check
bun run lint
bunx nx run-many -t build typecheck
```

Each OpenCode smoke installs the exact CLI selected by `scripts/opencode-compatibility.json` in a temporary consumer. No global CLI installation or shell command substitution is needed. Inspect the pinned version without installing anything:

```sh
bun -p 'require("./scripts/opencode-compatibility.json").host.version'
```

### macOS checks

Install Neovim (`nvim`) and tmux for parity and real-TUI checks. With Homebrew, use `brew install neovim tmux`. The full gate also needs network access for package installation and dependency audits.

```sh
bun run check
```

This runs the shared checks, policy tests, package tests, parity, package-content checks, installed-package smokes, and consumer audits. A successful run exits zero. Mocked-provider tests do not replace manual checks of real music playback.

### Linux checks

After the shared checks, run the same unit and package-content targets as the Linux CI job:

```sh
bun run policy:check
bunx nx run-many -t test format:check package:check
```

These checks do not require the macOS music provider. Platform-gated tests may skip unsupported integration cases. Leave real-host smokes and Neovim parity to the macOS integration job unless you are specifically investigating platform support.

### Windows checks

Use PowerShell for the shared commands and the following Windows CI targets:

```powershell
bunx nx run-many -t test format:check package:check --exclude=apnea
```

CI excludes Apnea's test and package-content targets on Windows and does not run the release-policy suite there. Apnea still receives type-check and lint coverage through the shared checks. Real-host smokes and parity run in the macOS integration job. WSL results are Linux evidence, not native Windows evidence.

### Focused checks and reporting

For a small change, select a project rather than running all package targets. For example, on macOS or Linux:

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=opencode-vim
```

The package project names are `music-core`, `opencode-music-player`, `opencode-vim`, `pi-music-dock`, `apnea`, and `pi-apnea`. Root automation is the `tooling` project. Keep the workspace-wide lint gate even for package-only changes.

On macOS with the required tools, include integrations with `bunx nx run-many -t typecheck test parity format:check package:check smoke --projects=opencode-vim --parallel=1`. Packing and smoke targets must run serially because OpenCode's prepack build replaces shared output. Nx skips targets that a selected project does not define.

In your PR, list your platform, commands, results, and any checks you could not run with the missing prerequisite. Do not mark an unavailable check as passed. CI remains responsible for the complete platform matrix and macOS integrations.

Keep changes focused and preserve each host integration contract. Add tests that explain why changed behavior matters. Use Conventional Commit messages, such as `fix(pi-music-dock): keep paused waveform still`.

The [OpenCode compatibility contract](docs/opencode-compatibility.md) records the supported host set and dependency proposal decisions. Update `scripts/opencode-compatibility.json`, both package manifests, and `bun.lock` together. Run `bun run compatibility:check` before the full workspace gate.

### Asynchronous correctness

`bun run lint` runs the workspace-wide async gate. `bunx nx run tooling:lint` runs the same gate without caching. The local check, CI quality matrix, Nx pre-version hook, and publication workflow all include it. A package-only check does not replace this workspace gate.

[`.oxlintrc.json`](.oxlintrc.json) enables exactly two error-level rules: `typescript/no-floating-promises` and `typescript/no-misused-promises`. Floating-promise checks include thenables and async IIFEs; `void` does not suppress them. Misused-promise checks include conditions, spreads, and every void-return callback position, including JSX attributes. Prettier owns formatting.

Oxlint 1.83.0 and oxlint-tsgolint 7.0.2001 use native TypeScript analysis. [Oxlint's type-aware implementation requires TypeScript 7](https://oxc.rs/docs/guide/usage/linter/type-aware), matching the project's TypeScript 7.0.2 compiler. This avoids a second legacy compiler installation. The gate adds no recommended rule preset or formatting rules.

The scanner independently enumerates `.ts`, `.tsx`, `.mts`, and `.cts` files, including declarations, production code, tests, and root tooling. It verifies each file against its nearest `tsconfig.json` using compiler file lists before passing explicit paths to Oxlint. Missing projects or omitted files fail the gate. Only dependency, generated-output, VCS, Nx-cache, and Apnea-state directories are excluded: `node_modules`, `dist`, `.git`, `.jj`, `.nx`, and `.apnea`. Nested lint configurations and ignore files cannot narrow the gate.

Await or return work when its caller owns completion. For synchronous event callbacks, handle rejection and identify the lifecycle owner in a nearby comment. Session disposal owns music commands; renderer cleanup fences pending artwork paints. Tests must join their background work and teardown. Do not replace an error path with an empty catch or a bare `void`.

`scripts/async-lint.test.ts` runs the real scanner and linter on temporary source projects. It proves both rules reject production, test, TSX, and tooling fixtures, accepts repaired fixtures, and rejects omitted TSX and orphan automation files.

## Releasing

The packages release independently. Nx derives versions from Conventional Commits, creates `<project>@v<version>` tags, pushes the release commit and tag, and creates GitHub releases with generated notes. No committed changelog update is required after the initial package snapshots.

Preview every release before applying it:

```sh
bunx nx release --projects=<project> --skip-publish --dry-run
bunx nx release --projects=<project> --skip-publish
```

Both commands run the dependency audit, release-policy tests, and package gates before changing versions. The pushed tag starts `.github/workflows/publish.yml`. CI checks out the exact tag, validates the project mapping and package manifest, repeats the security and package gates, and publishes directly from `packages/<project>`. Stable versions use the npm `latest` dist-tag. Prereleases use `next`.

Re-run an existing tag with:

```sh
gh workflow run publish.yml -f tag=<project>@vX.Y.Z
```

The workflow is idempotent. It succeeds without republishing when the exact package version already exists.

Music host package gates require the staged `music-core` version to satisfy the host's declared dependency range. Their coordinated-source smokes still install local core tarballs. Before publishing a new host version, CI also runs `bun run --cwd packages/<host> prepublish:core` for `opencode-music-player` and `pi-music-dock`.

This network-only gate queries the public npm registry up to ten times, with a 15-second command deadline and five seconds between attempts. It then packs the host and installs it in a temporary consumer with a fresh npm cache, no workspace configuration, and no core override. Installation has a three-minute deadline. A 30-second probe verifies the resolved core manifest range and loads the host. Pi's supported peer versions use its development pins. Temporary files are removed afterward. Command termination may add up to ten seconds to each deadline.

If the gate fails, publish a compatible core first, allow registry propagation, then rerun the host tag. A compatible published version is sufficient; the staged core need not be published. These network checks run only before new publication or when invoked manually, not in the offline unit suite or version preview. Already-published tags skip them.

The host-side catalog acquisition exports added for #129 and #140 require a new core release. Publish that core before either updated music host. Then set both host dependency floors to that published version and regenerate the lockfile before publishing hosts. The current `0.1.3` core does not provide these exports; a range that accepts it is insufficient for the updated hosts. Keep the source checkout's frozen install intact until the new core is available. Confirm the exact next core version with the release preview rather than reserving an unpublished version in host manifests.

### Trusted publishing

After each package exists on npm, configure its npm Trusted Publisher with:

- Organization or user: `naxodev`
- Repository: `ai`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Allowed actions: `npm publish`

Do not configure an npm token. The workflow uses npm 11, OIDC trusted publishing, and provenance. The GitHub `production` environment protects production runs, but the npm trusted publisher environment field remains blank. npm trusted publishers created after May 20, 2026 require at least one allowed action.

### First publication

npm does not allow trusted publisher configuration before a package exists. A maintainer must bootstrap version `0.1.0` once from each unpublished package directory with an interactive npm account and 2FA. Publish `@naxodev/music-core` before the dependent music hosts. Publish `@naxodev/apnea` before `@naxodev/pi-apnea`:

```sh
bun run check
cd packages/music-core
npm publish --access public --provenance=false
cd ../opencode-music-player
npm publish --access public --provenance=false
cd ../opencode-vim
npm publish --access public --provenance=false
cd ../pi-music-dock
npm publish --access public --provenance=false
cd ../apnea
npm publish --access public --provenance=false
cd ../pi-apnea
npm publish --access public --provenance=false
```

Configure each trusted publisher immediately afterward. Every later release uses OIDC and includes provenance.

Create the initial release tags on the bootstrap commit so future Nx releases have a version baseline:

```sh
git tag -a music-core@v0.1.0 -m "music-core@v0.1.0"
git tag -a opencode-music-player@v0.1.0 -m "opencode-music-player@v0.1.0"
git tag -a opencode-vim@v0.1.0 -m "opencode-vim@v0.1.0"
git tag -a pi-music-dock@v0.1.0 -m "pi-music-dock@v0.1.0"
git tag -a apnea@v0.1.0 -m "apnea@v0.1.0"
git tag -a pi-apnea@v0.1.0 -m "pi-apnea@v0.1.0"
git push origin music-core@v0.1.0 opencode-music-player@v0.1.0 opencode-vim@v0.1.0 pi-music-dock@v0.1.0 apnea@v0.1.0 pi-apnea@v0.1.0
```

These tag-triggered workflow runs are safe after the manual publications because their registry checks skip existing versions.

### Verification

```sh
npm view @naxodev/<package> version
npm view @naxodev/<package> dist-tags
npm view @naxodev/<package>@<version> --json
```

Do not automate removal of stale npm dist-tags. A maintainer should correct dist-tags manually if a back-patch would move `latest` to an older release line.
