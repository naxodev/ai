import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { runBoundedCommand } from "./bounded-process.ts"
import { assertPeerVersion } from "./package-smoke-policy.ts"

export const PACKAGE_SMOKE_TIMEOUTS = {
  build: 60_000,
  pack: 60_000,
  install: 120_000,
  rpc: 30_000,
} as const

async function command(
  args: string[],
  cwd: string,
  label: string,
  timeoutMs: number,
  stdin?: string,
) {
  const result = await runBoundedCommand(args, {
    cwd,
    label,
    timeoutMs,
    stdin,
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  return result
}

async function pack(cwd: string, destination: string): Promise<string> {
  const result = await command(
    ["npm", "pack", "--silent", "--pack-destination", destination],
    cwd,
    `npm pack ${basename(cwd)}`,
    PACKAGE_SMOKE_TIMEOUTS.pack,
  )
  const archive = result.stdout.trim().split("\n").at(-1)
  if (!archive) throw new Error(`npm pack ${basename(cwd)} returned no archive`)
  return resolve(destination, archive)
}

export async function runPackageSmoke(): Promise<void> {
  const packageDir = resolve(import.meta.dir, "..")
  const coreDir = resolve(packageDir, "../apnea")
  const packageManifest = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  ) as { peerDependencies: Record<string, string> }
  const piPackage = "@earendil-works/pi-coding-agent"
  const piPeerRange = packageManifest.peerDependencies[piPackage]
  if (!piPeerRange) throw new Error(`missing ${piPackage} peer dependency`)
  const work = await mkdtemp(join(tmpdir(), "pi-apnea-package-smoke-"))

  try {
    await command(
      ["bun", "run", "build"],
      coreDir,
      "Apnea core build",
      PACKAGE_SMOKE_TIMEOUTS.build,
    )
    const coreArchive = await pack(coreDir, work)
    const piArchive = await pack(packageDir, work)
    await writeFile(
      join(work, "package.json"),
      `${JSON.stringify({
        private: true,
        dependencies: {
          "@naxodev/pi-apnea": piArchive,
        },
        overrides: { "@naxodev/apnea": coreArchive },
      })}\n`,
    )
    await command(
      ["bun", "install"],
      work,
      "packed adapter install",
      PACKAGE_SMOKE_TIMEOUTS.install,
    )
    const pi = join(work, "node_modules", ".bin", "pi")
    const installedPiManifest = JSON.parse(
      await readFile(
        join(work, "node_modules", piPackage, "package.json"),
        "utf8",
      ),
    ) as { version: string }
    assertPeerVersion(installedPiManifest.version, piPeerRange)
    const rpc = await command(
      [
        pi,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "-e",
        join(work, "node_modules", "@naxodev", "pi-apnea"),
      ],
      work,
      "Pi RPC package smoke",
      PACKAGE_SMOKE_TIMEOUTS.rpc,
      '{"type":"get_commands","id":"smoke"}\n',
    )
    const response = rpc.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((message) => message.id === "smoke")
    const commands = (response?.data as { commands?: Array<{ name?: string }> })
      ?.commands
    for (const name of ["apnea", "apnea-start", "apnea-status"]) {
      if (!commands?.some((registered) => registered.name === name)) {
        throw new Error(`Pi did not load /${name} from the packed adapter`)
      }
    }
    console.log(
      `Installed ${basename(piArchive)} with packed core; Pi loaded all commands.`,
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main) await runPackageSmoke()
