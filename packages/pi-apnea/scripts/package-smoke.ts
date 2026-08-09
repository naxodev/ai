import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { assertPeerVersion } from "./package-smoke-policy.ts"

function pack(cwd: string, destination: string): string {
  const result = Bun.spawnSync(
    ["npm", "pack", "--silent", "--pack-destination", destination],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (!result.success) throw new Error(result.stderr.toString())
  return resolve(
    destination,
    result.stdout.toString().trim().split("\n").at(-1)!,
  )
}

const packageDir = resolve(import.meta.dir, "..")
const coreDir = resolve(packageDir, "../apnea")
const packageManifest = JSON.parse(
  await readFile(join(packageDir, "package.json"), "utf8"),
) as { peerDependencies: Record<string, string> }
const piPackage = "@earendil-works/pi-coding-agent"
const piPeerRange = packageManifest.peerDependencies[piPackage]
if (!piPeerRange) throw new Error(`missing ${piPackage} peer dependency`)
const work = await mkdtemp(join(tmpdir(), "pi-apnea-package-smoke-"))
await Bun.$`bun run build`.cwd(coreDir).quiet()
const coreArchive = pack(coreDir, work)
const piArchive = pack(packageDir, work)

try {
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
  const install = Bun.spawnSync(["bun", "install"], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!install.success) throw new Error(install.stderr.toString())
  const pi = join(work, "node_modules", ".bin", "pi")
  const installedPiManifest = JSON.parse(
    await readFile(
      join(work, "node_modules", piPackage, "package.json"),
      "utf8",
    ),
  ) as { version: string }
  assertPeerVersion(installedPiManifest.version, piPeerRange)
  const child = Bun.spawn(
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
    { cwd: work, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  child.stdin.write('{"type":"get_commands","id":"smoke"}\n')
  child.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Pi exited ${exitCode}: ${stderr}`)
  const response = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((message) => message.id === "smoke")
  const commands = (response?.data as { commands?: Array<{ name?: string }> })
    ?.commands
  for (const name of ["apnea", "apnea-start", "apnea-status"]) {
    if (!commands?.some((command) => command.name === name)) {
      throw new Error(`Pi did not load /${name} from the packed adapter`)
    }
  }
  console.log(
    `Installed ${basename(piArchive)} with packed core; Pi loaded all commands.`,
  )
} finally {
  await rm(work, { recursive: true, force: true })
}
