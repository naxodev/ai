import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

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
  const pi = Bun.which("pi")
  if (!pi) throw new Error("could not resolve the Pi executable from PATH")
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
