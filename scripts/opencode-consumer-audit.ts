import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runBoundedCommand } from "./bounded-process.ts"
import {
  assertOpenCodeCompatibility,
  hostDependencies,
} from "./opencode-compatibility.ts"

const workspace = fileURLToPath(new URL("../", import.meta.url))
const root = await mkdtemp(join(tmpdir(), "opencode-consumer-audit-"))
let failed = false
try {
  for (const host of ["opencode-vim", "opencode-music-player"]) {
    const directory = join(root, host)
    await mkdir(directory)
    const dependencies: Record<string, string> = {}
    for (const project of host === "opencode-vim"
      ? [host]
      : [host, "music-core"]) {
      const packed = await runBoundedCommand(
        ["npm", "pack", "--silent", "--pack-destination", directory],
        {
          cwd: join(workspace, "packages", project),
          label: `pack ${project}`,
          timeoutMs: 30_000,
        },
      )
      if (packed.exitCode !== 0) throw new Error(packed.stderr)
      const filename = packed.stdout.trim().split("\n").at(-1)
      if (
        !filename ||
        basename(filename) !== filename ||
        !filename.endsWith(".tgz")
      )
        throw new Error(`Invalid archive for ${project}`)
      const manifest = (await Bun.file(
        join(workspace, "packages", project, "package.json"),
      ).json()) as { name: string }
      dependencies[manifest.name] = `file:${join(directory, filename)}`
    }
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ private: true, dependencies, trustedDependencies: [] }),
    )
    const install = await runBoundedCommand(
      ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: directory, label: `install ${host} consumer`, timeoutMs: 180_000 },
    )
    if (install.exitCode !== 0) throw new Error(install.stderr)
    const installed = join(directory, "node_modules", "@naxodev", host)
    assertOpenCodeCompatibility([
      await Bun.file(join(installed, "package.json")).json(),
    ])
    const lock = (await Bun.file(
      join(directory, "package-lock.json"),
    ).json()) as {
      packages: Record<string, unknown>
    }
    for (const name of Object.keys(hostDependencies)) {
      if (
        Object.keys(lock.packages).some((path) =>
          path.endsWith(`node_modules/${name}`),
        )
      )
        throw new Error(
          `${host}: host-provided ${name} was installed in the consumer`,
        )
    }
    const audit = await runBoundedCommand(["npm", "audit", "--omit=dev"], {
      cwd: directory,
      label: `audit ${host} consumer`,
      timeoutMs: 30_000,
    })
    console.log(`Packed consumer: ${host}\n${audit.stdout}${audit.stderr}`)
    failed ||= audit.exitCode !== 0
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
