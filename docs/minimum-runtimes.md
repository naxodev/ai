# Minimum Bun verification

Run `bun run compatibility:minimum-bun` from the repository root. The full local check, macOS integration job, pre-version hook, and publication workflow include it. The check needs npm registry access and runs serially with other packing targets.

The script reads every package's `engines.bun` lower bound. It downloads exact platform-specific Bun binaries into temporary directories, checks their version output, and runs packed consumers outside the workspace. Unsupported range syntax fails instead of silently selecting the current toolchain. Builds and dependency installation use the current toolchain; execution uses the advertised minimum. No global Bun installation is changed.

## Verified behavior

| Package               | Declared minimum | Consumer behavior                                                                                                           |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Apnea                 | Bun 1.3.7        | Public API and packaged briefs load; CLI status reports no run in the isolated consumer.                                    |
| Music-core            | Bun 1.3.0        | Root exports load; formatting and independent state work; controlled transient acquisition exhausts exactly three attempts. |
| OpenCode music-player | Bun 1.3.0        | Compiled public TUI entrypoint loads with explicitly supplied supported peers and exposes its plugin definition.            |
| OpenCode Vim          | Bun 1.3.0        | Compiled public TUI entrypoint loads with explicitly supplied supported peers and exposes its plugin definition.            |

Both Pi adapters declare Node requirements, not Bun engine ranges. Pi-Apnea's transitive executable is covered by the Apnea case. This check does not establish Node minimum support.

The table records the checked baseline; the executable check discovers current manifest ranges rather than copying these versions. Regenerate [compatibility metadata](package-compatibility.md) after changing an engine range and update this evidence account if behavior changes.

## OpenCode boundary

The supported OpenCode executable supplies its own Bun runtime and shared renderer libraries. It cannot be replaced with an arbitrary Bun binary. Exact-host package-name, renderer, and reload smokes remain the functional host evidence. The minimum-runtime check is a compiled-entrypoint check, not a claim that all renderer behavior works on standalone Bun.

Standalone probe consumers explicitly install the supported peers. They override only Solid's peer resolution to the verified host version because OpenTUI's published peer metadata disagrees with its host. This fixture does not change published package dependencies or the clean-consumer security audit. Installation scripts are disabled. Probe execution is bounded and temporary consumers are removed on completion or failure.

No minimum failed these probes, so engine ranges remain unchanged. A future failing minimum must be fixed or raised with a compatibility reference update and release note.
