const manifest = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as { name: string; version: string }
const packed = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
  stdout: "pipe",
  stderr: "pipe",
})
if (!packed.success) throw new Error(packed.stderr.toString())
const [description] = JSON.parse(packed.stdout.toString()) as Array<{
  name: string
  version: string
  files: Array<{ path: string }>
}>
if (!description) throw new Error("npm pack did not describe an archive")
if (
  description.name !== manifest.name ||
  description.version !== manifest.version
) {
  throw new Error(
    `unexpected package identity ${description.name}@${description.version}`,
  )
}
const files = new Set(description.files.map(({ path }) => path))
const expected = new Set(
  `CONTEXT.md
CONTRIBUTING.md
LICENSE
README.md
SECURITY.md
briefs/coder.md
briefs/orchestrator.md
briefs/planner.md
briefs/reviewer.md
dist/cli.js
docs/adr/0001-completion-signaling.md
docs/adr/0002-orchestrator-authority.md
docs/adr/0003-verify-at-gate.md
docs/adr/0004-artifact-layout-and-naming.md
docs/adr/0005-harness-profiles.md
docs/adr/0006-config-trust-model.md
docs/adr/0007-jj-first-commits.md
docs/adr/0008-effect-v4-internals.md
docs/adr/0009-cli-driver-split.md
docs/adr/0010-package-split.md
docs/protocol/artifacts.md
docs/protocol/config.md
docs/protocol/manual-gate.md
docs/protocol/overview.md
extension/adapters/commit.ts
extension/adapters/dispatch.ts
extension/adapters/setup.ts
extension/adapters/start.ts
extension/adapters/status.ts
extension/adapters/wait.ts
extension/api.ts
extension/cli/format.ts
extension/cli/human-gate.ts
extension/cli/main.ts
extension/cli/parse.ts
extension/domain/artifact-kind.ts
extension/domain/frontmatter.ts
extension/domain/herdr.ts
extension/domain/paths.ts
extension/domain/recovery.ts
extension/domain/rounds.ts
extension/domain/setup.ts
extension/domain/slug.ts
extension/domain/state-machine.ts
extension/domain/timeouts.ts
extension/domain/types.ts
extension/domain/verify-commands.ts
extension/errors.ts
extension/host-adapter.ts
extension/registry.ts
extension/result.ts
extension/run-tool.ts
extension/schema/config.ts
extension/schema/frontmatter.ts
extension/schema/state.ts
extension/services/app-live.ts
extension/services/config.ts
extension/services/file-system.ts
extension/services/herdr.ts
extension/services/operation-lock.ts
extension/services/run-store.ts
extension/services/vcs.ts
extension/workflows/commit.ts
extension/workflows/dispatch.ts
extension/workflows/reset.ts
extension/workflows/setup.ts
extension/workflows/start.ts
extension/workflows/status.ts
extension/workflows/wait.ts
package.json
schemas/artifact-frontmatter.md
schemas/config.schema.json
schemas/state.schema.json`.split("\n"),
)
const missing = [...expected].filter((path) => !files.has(path))
const unexpected = [...files].filter((path) => !expected.has(path))
if (missing.length > 0)
  throw new Error(`npm package is missing: ${missing.join(", ")}`)
if (unexpected.length > 0)
  throw new Error(
    `npm package contains unexpected files: ${unexpected.join(", ")}`,
  )
console.log(`Verified ${manifest.name} package contents (${files.size} files)`)
