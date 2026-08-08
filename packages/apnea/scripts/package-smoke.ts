import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

await Bun.$`bun run build`.quiet()
const work = await mkdtemp(join(tmpdir(), "apnea-package-smoke-"))
const packed = Bun.spawnSync(
  ["npm", "pack", "--silent", "--pack-destination", work],
  {
    stdout: "pipe",
    stderr: "pipe",
  },
)
if (!packed.success) throw new Error(packed.stderr.toString())
const archive = resolve(
  work,
  packed.stdout.toString().trim().split("\n").at(-1)!,
)

try {
  await writeFile(join(work, "package.json"), '{"private":true}\n')
  const install = Bun.spawnSync(["bun", "add", archive], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!install.success) throw new Error(install.stderr.toString())
  const cli = join(work, "node_modules", ".bin", "apnea")
  const help = Bun.spawnSync([cli, "help"], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!help.success || !help.stdout.toString().includes("start <goal>")) {
    throw new Error(`packed CLI failed: ${help.stderr.toString()}`)
  }
  const rootCheck = Bun.spawnSync(
    [
      "bun",
      "-e",
      'import { packageRoot } from "@naxodev/apnea"; console.log(packageRoot())',
    ],
    { cwd: work, stdout: "pipe", stderr: "pipe" },
  )
  if (!rootCheck.success) throw new Error(rootCheck.stderr.toString())
  const packageRoot = rootCheck.stdout.toString().trim()
  const brief = await readFile(join(packageRoot, "briefs", "coder.md"), "utf8")
  if (!brief.includes("coder"))
    throw new Error("packed package root did not resolve briefs")
  console.log(`Installed ${basename(archive)}; CLI and resources resolved.`)
} finally {
  await rm(work, { recursive: true, force: true })
}
