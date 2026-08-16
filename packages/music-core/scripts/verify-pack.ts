const expectedFiles = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "clock.ts",
  "format.ts",
  "index.ts",
  "package.json",
  "reconcile.ts",
  "run.ts",
  "system-media.ts",
  "types.ts",
  "waveform.ts",
  "dist/music-sessiond.js",
  "session/client.ts",
  "session/config.ts",
  "session/coordinator.ts",
  "session/framing.ts",
  "session/music-sessiond.ts",
  "session/protocol.ts",
  "session/provider.ts",
  "session/server.ts",
])
const manifest = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as {
  exports?: Record<string, string>
  bin?: Record<string, string>
}
if (manifest.exports?.["."] !== "./index.ts")
  throw new Error("package root export must point at index.ts")
if (manifest.bin?.["naxodev-music-sessiond"] !== "./dist/music-sessiond.js")
  throw new Error("package bin must point at dist/music-sessiond.js")
const process = Bun.spawn(
  ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
  { stdout: "pipe", stderr: "inherit" },
)
const output = await new Response(process.stdout).text()
if ((await process.exited) !== 0) throw new Error("npm pack --dry-run failed")
const packs = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>
const files = new Set(packs[0]?.files.map(({ path }) => path))
for (const expected of expectedFiles)
  if (!files.has(expected))
    throw new Error(`npm package is missing ${expected}`)
for (const file of files)
  if (!expectedFiles.has(file))
    throw new Error(`npm package contains unexpected file ${file}`)
console.log(`Verified npm package contents (${files.size} files)`)
