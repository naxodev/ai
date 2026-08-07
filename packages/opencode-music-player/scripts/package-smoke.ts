import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const packed = Bun.spawnSync(["npm", "pack", "--silent"], {
  cwd: process.cwd(),
  stdout: "pipe",
  stderr: "pipe",
})
if (!packed.success) throw new Error(`npm pack failed: ${packed.stderr}`)

const archiveName = packed.stdout.toString().trim().split("\n").at(-1)
if (!archiveName) throw new Error("npm pack did not produce an archive")

const archive = resolve(archiveName)
const work = await mkdtemp(join(tmpdir(), "opencode-music-player-smoke-"))

try {
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "@naxodev/opencode-music-player": `file:${archive}` },
    }),
  )

  const install = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!install.success)
    throw new Error(`package install failed: ${install.stderr}`)

  const loaded = Bun.spawnSync(
    [
      "bun",
      "-e",
      'import plugin from "@naxodev/opencode-music-player"; if (plugin.id !== "music-player" || typeof plugin.setup !== "function") process.exit(1)',
    ],
    { cwd: work, stdout: "pipe", stderr: "pipe" },
  )
  if (!loaded.success)
    throw new Error(`package import failed: ${loaded.stderr}`)

  console.log("OpenCode loaded the packed TypeScript entrypoint.")
} finally {
  await rm(work, { recursive: true, force: true })
  await rm(archive, { force: true })
}
