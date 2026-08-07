const expectedFiles = new Set([
  "LICENSE",
  "README.md",
  "SUPPORT.md",
  "index.tsx",
  "package.json",
  "system-media.ts",
  "types.ts",
  "ui.tsx",
  "waveform.tsx",
])

const process = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
  stdout: "pipe",
  stderr: "inherit",
})
const output = await new Response(process.stdout).text()
if ((await process.exited) !== 0) throw new Error("npm pack --dry-run failed")

const packs = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>
const files = new Set(packs[0]?.files.map(({ path }) => path))

for (const expected of expectedFiles) {
  if (!files.has(expected))
    throw new Error(`npm package is missing ${expected}`)
}

for (const file of files) {
  if (file.startsWith("tests/") || file.startsWith("scripts/")) {
    throw new Error(`npm package contains development file ${file}`)
  }
}

console.log(`Verified npm package contents (${files.size} files)`)
