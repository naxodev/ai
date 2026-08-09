const manifest = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as {
  name: string
  version: string
}
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
const expected = new Set([
  "LICENSE",
  "README.md",
  "extension/commands.ts",
  "extension/index.ts",
  "extension/pi-role-agent.ts",
  "extension/runtime.ts",
  "package.json",
  "prompts/apnea-init.md",
  "skills/apnea-orchestrator/SKILL.md",
  "skills/apnea-setup/SKILL.md",
])
const missing = [...expected].filter((path) => !files.has(path))
const unexpected = [...files].filter((path) => !expected.has(path))
if (missing.length > 0)
  throw new Error(`npm package is missing: ${missing.join(", ")}`)
if (unexpected.length > 0) {
  throw new Error(
    `npm package contains unexpected files: ${unexpected.join(", ")}`,
  )
}
console.log(`Verified ${manifest.name} package contents (${files.size} files)`)
