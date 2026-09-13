# OpenCode compatibility contract

Both OpenCode plugins share one exact supported host set in [scripts/opencode-compatibility.json](../scripts/opencode-compatibility.json).

- `@opencode/cli`, `@opencode/plugin`, and `@opencode/theme`: `2.0.3`.
- `@opentui/core` and `@opentui/solid`: `0.5.10`.
- `solid-js`: `1.9.15`.

The [stable CLI source catalog](https://github.com/anomalyco/opencode/blob/v2.0.3/package.json) selects these OpenTUI and Solid versions. Upstream `@opencode/plugin@2.0.3` declares optional OpenTUI peers `>=0.5.10` and theme `2.0.3`. OpenTUI Solid still declares a `solid-js` peer of `1.9.12`; the host uses `1.9.15`. Bun reports that metadata mismatch. Type-checks and packed real-host smokes establish support for the exact host combination, not a wider range.

`bun run compatibility:check` checks both manifests, their lockfile workspace entries, and all coupled lockfile resolutions. It rejects mixed versions and ranges before packing or launching a host. Policy tests prove that a core-only update and a mismatched host fail. Both package smokes use the same host manifest and verify the installed executable's version. Dependabot groups OpenCode, OpenTUI, and Solid updates outside the development-only group. A grouped proposal still requires updating the compatibility contract and passing the full gates.

## Stable V2 migration

The previous set used `@opencode-ai/plugin@0.0.0-next-17444`, theme `0.0.0`, and different OpenTUI versions across the plugins. Stable V2 uses the `@opencode` namespace and the `opencode` executable. Plugin imports now use `@opencode/plugin/tui`.

The [stable CLI plugin contract](https://opencode.ai/v2/docs/build/plugins/cli) retains the consumed slot, keymap, storage, theme, and cleanup APIs. npm packages expose `./tui`; local configuration points to the generated `dist` directory containing `tui.js`. The stable local loader resolves the `tui` basename rather than package exports and ignores single-file plugin paths. CLI configuration lives in global `cli.json`; the smokes use isolated XDG directories and a private `--standalone` host.

OpenTUI `0.5.10` clears selection when assigning `EditBufferRenderable.cursorOffset`. Vim must move the cursor before restoring selection. Real-renderer regression tests cover visual reload reconciliation and change motions. The packed host gate also preserves visual mode, undo history, and the unnamed register across reload.

Music-core and Apnea retain Effect `4.0.0-rc.111`. OpenCode's published packages use `4.0.0-rc.112` in their own dependency graph. The music adapter crosses the host boundary through ordinary values, callbacks, and Promises, not host Effect services or fibers. No workspace-wide Effect override is introduced.

The workspace overrides `@opentelemetry/core` to `2.8.0` and Babel to `7.29.7` for development dependencies. Packed consumers do not need these overrides. The prebuilt host has a separate dependency boundary, described below.

This migration breaks compatibility with the prior beta host. The next release of each OpenCode plugin must disclose that requirement and use a pre-1.0 breaking minor release. Package versions are not changed by this migration. Users who need the beta host must retain their previous plugin release.

Nx 23 defaults to commit-scope matching. The shared `opencode` scope does not equal either project name, so that default incorrectly reduces this breaking migration to patches. The release configuration explicitly uses file-based matching. A version-only dry run resolved music `0.2.6 → 0.3.0` and Vim `0.1.2 → 0.2.0`, with staging, commit, tag, and push disabled. The consumer audit remains a release gate.

## Dependency proposals

- [#117](https://github.com/naxodev/ai/pull/117) updates only OpenTUI core to `0.5.11`. Mixed branded renderables fail type-checks. This proposal is superseded by the coordinated `0.5.10` host set.
- [#118](https://github.com/naxodev/ai/pull/118) updates only OpenTUI Solid to `0.5.11`. It is also superseded. `0.5.11` is newer than the stable CLI's embedded renderer and has no packed-host evidence here.
- [#119](https://github.com/naxodev/ai/pull/119) updates `@opencode-ai/plugin` to `1.18.30`. That package is legacy V1, not the stable V2 TUI API. The namespace migration replaces this proposal.

These decisions reconcile the proposed versions locally. Closing the remote proposals is a separate maintainer action.

## Verification boundary

The full gate is `bun run check`. It includes dependency audit, consistency policy, formatting, workspace type-checks, unit tests, Neovim parity, package contents, and six package smokes. Both OpenCode smokes install packed consumers and the exact CLI in temporary directories. Only the CLI installation hook is trusted. Vim uses `clipboard: "none"`; music uses deterministic fixtures rather than user playback.

## Package-name installation coverage

Before publication, the package smokes serve the current packed artifacts through a temporary loopback registry. The host starts with an empty npm cache and resolves documented package names. The registry asserts metadata and tarball requests, serves unrelated dependency metadata from npm, and refuses unknown `@naxodev` packages. It cannot silently fetch an older public plugin version.

Vim loads its unmodified packed artifact through an options object and asserts `startMode: "normal"`. Its instrumented directory-based reload scenario then runs separately. Music loads through the string form and checks both its host and core tarball downloads. It retains the existing deterministic media fixture wrapper around the packed implementation, then runs the directory-based paused and resized presentations. No user media provider is used.

This covers the prepublication package-resolver contract in #134. After publication, verify each exact released `@naxodev/<package>@<version>` in a new isolated host configuration against the public registry. That publication check remains unrun because these versions have not been published. The loopback checks verify the current source artifacts, not public-registry propagation.

## Host-provided dependencies

`npm pack` precompiles each plugin's TypeScript and JSX into `dist/index.js`; `dist/tui.js` re-exports the same default plugin. The build keeps every package import external. It bundles neither the renderer nor Solid, and the compiler remains a development dependency. The public `.` and `./tui` exports remain available.

This build step is required by the exact host: packed TSX failed with `Cannot find package '@opentui/solid'` at its JSX import-source pragma when OpenTUI was absent. The host successfully resolves the precompiled artifact's ordinary imports to its embedded modules. Source edits require rebuilding before local host reload.

Both packages require the exact supported OpenCode Bun host. They declare `@opencode/plugin`, `@opentui/core`, and `@opentui/solid` as exact optional peers and exact development dependencies. Solid remains a required host-supplied module with an exact `1.9.15` development pin, but no npm peer metadata. The executable supplies all four modules; npm does not install copies for ordinary plugin consumers. Music-core and pngjs remain production dependencies.

The [official CLI plugin guide](https://opencode.ai/v2/docs/build/plugins/cli) documents runtime resolution of `@opencode/plugin/tui`. The [stable host setup](https://github.com/anomalyco/opencode/blob/v2.0.3/packages/tui/src/plugin/runtime-plugin-support.bun.ts) registers that module with OpenTUI's runtime resolver. The [OpenTUI Solid configurator](https://unpkg.com/@opentui/solid@0.5.10/scripts/runtime-plugin-support-configure.js) supplies OpenTUI, JSX runtimes, Solid, and Solid store. The [core resolver](https://unpkg.com/@opentui/core@0.5.10/runtime-plugin.js) rewrites external ESM imports, including packages under `node_modules`, to the host's module instances. This preserves renderer and reactive-context identity.

Optional peers describe host provision, not an optional feature. npm peer metadata cannot validate an executable's embedded versions. The compatibility guard and packed real-host smokes enforce that requirement. The upstream documentation's publication example uses a runtime plugin dependency and ordinary OpenTUI peers; these packages deliberately use the narrower host-provided contract.

Standalone loading outside OpenCode is unsupported. Workspace export tests use the exact development dependencies from the lockfile. Package smokes install production consumers with npm and assert that all four host libraries are absent before launching the executable. The empty-cache package-name scenario separately installs each plugin through OpenCode. This replaces the earlier standalone Bun import smoke, whose fresh development dependency resolution could stall before host startup. Direct Node loading remains unsupported.

## Packed-consumer audit

`bun run security:consumers` packs each plugin independently, installs a consumer without overrides or install scripts, and runs `npm audit --omit=dev`. It checks the installed manifest and rejects any installed host library, including Solid. This gate covers the actual published plugin dependency graph.

The former production dependencies installed two unnecessary advisory chains: OpenTUI Solid's Babel `7.28.0` ([GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8)) and the plugin package's util/tracing dependencies with OpenTelemetry core `2.6.1` ([GHSA-8988-4f7v-96qf](https://github.com/advisories/GHSA-8988-4f7v-96qf)). Host-provided dependencies remove those chains from plugin installs. No audit suppression or consumer override is used.

npm `11.12.1` and `10.9.4` reject even absent optional peers when their prospective graph conflicts. A reduced tarball containing only optional peers `@opentui/solid: 0.5.10` and `solid-js: 1.9.15` reproduces `ERESOLVE`. Removing development dependencies does not help. Therefore Solid has no npm peer declaration. The compatibility guard still requires its exact development pin and rejects production dependencies, peer metadata, or mixed lockfile resolutions. This metadata choice does not widen supported host versions.

## Bundled host security boundary

The [tagged host lockfile](https://github.com/anomalyco/opencode/blob/v2.0.3/bun.lock) resolves fixed Babel `7.29.7` and affected OpenTelemetry core `2.6.1`. The binary's npm manifest cannot audit its bundled dependencies. A clean plugin-consumer audit does not establish an audit-clean binary.

The OpenTelemetry advisory affects `W3CBaggagePropagator.extract()` on inbound baggage. In the inspected stable [tracing setup](https://github.com/anomalyco/opencode/blob/v2.0.3/packages/util/src/observability/otlp.ts), no OTLP endpoint means no tracing layer. With an endpoint, [Effect's NodeSdk `4.0.0-rc.112`](https://unpkg.com/@effect/opentelemetry@4.0.0-rc.112/dist/NodeSdk.js) constructs a tracer provider but does not call `register()`. The [provider `2.6.1`](https://unpkg.com/@opentelemetry/sdk-trace-node@2.6.1/build/src/NodeTracerProvider.js) installs the baggage propagator through `register()`, not construction. The inspected Effect tracer uses span/context APIs, and the stable repository's package TypeScript has no baggage extraction call.

No stock-host path to the vulnerable extractor was found in this tracing setup. This is source evidence, not a whole-binary proof covering every transitive integration or third-party plugin. An upstream fixed host remains desirable. The removed consumer dependency chain alone is not evidence of a reachable host exploit and does not create an additional release block. The consumer audit continues to fail on actual installed findings.
