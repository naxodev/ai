import { assertOpenCodeCompatibility } from "../../../scripts/opencode-compatibility.ts"

const expectedFiles = new Set([
  "LICENSE",
  "LICENSE.vimcode",
  "README.md",
  "dist/index.js",
  "dist/tui.js",
  "package.json",
])

const manifest = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as { name: string; version: string }
assertOpenCodeCompatibility([manifest])

const packed = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
  stdout: "pipe",
  stderr: "pipe",
})
if (!packed.success)
  throw new Error(`npm pack --dry-run failed: ${packed.stderr.toString()}`)

const packs = JSON.parse(packed.stdout.toString()) as Array<{
  name: string
  version: string
  files: Array<{ path: string }>
}>
const pack = packs[0]
if (!pack) throw new Error("npm pack did not describe an archive")
if (pack.name !== manifest.name || pack.version !== manifest.version)
  throw new Error(`unexpected package identity ${pack.name}@${pack.version}`)

const files = new Set(pack.files.map(({ path }) => path))
const missing = [...expectedFiles].filter((file) => !files.has(file))
const unexpected = [...files].filter((file) => !expectedFiles.has(file))
if (missing.length > 0)
  throw new Error(`npm package is missing: ${missing.join(", ")}`)
if (unexpected.length > 0)
  throw new Error(
    `npm package contains unexpected files: ${unexpected.join(", ")}`,
  )

console.log(`Verified npm package contents (${files.size} files)`)
