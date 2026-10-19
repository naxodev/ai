import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { runBoundedCommand } from "./bounded-process.ts"
import { assertPeerVersion, selectPiVersion } from "./package-smoke-policy.ts"

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
  env?: NodeJS.ProcessEnv,
) {
  const result = await runBoundedCommand(args, {
    cwd,
    label,
    timeoutMs,
    stdin,
    env,
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

export async function runPackageSmoke(
  piVersionOverride?: string,
): Promise<void> {
  const packageDir = resolve(import.meta.dir, "..")
  const coreDir = resolve(packageDir, "../apnea")
  const packageManifest = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  ) as {
    peerDependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
  const piPackage = "@earendil-works/pi-coding-agent"
  const piPeerRange = packageManifest.peerDependencies[piPackage]
  if (!piPeerRange) throw new Error(`missing ${piPackage} peer dependency`)
  const piVersion = selectPiVersion(
    packageManifest.devDependencies[piPackage]!,
    piPeerRange,
    piVersionOverride,
  )
  const work = await mkdtemp(join(tmpdir(), "pi-apnea-package-smoke-"))
  const isolatedEnv = {
    ...process.env,
    HOME: work,
    XDG_CONFIG_HOME: join(work, "config"),
    XDG_CACHE_HOME: join(work, "cache"),
    XDG_DATA_HOME: join(work, "data"),
    XDG_STATE_HOME: join(work, "state"),
    PI_CODING_AGENT_DIR: join(work, "agent"),
  }

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
          [piPackage]: piVersion,
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
    if (installedPiManifest.version !== piVersion)
      throw new Error(
        `expected Pi ${piVersion}, installed ${installedPiManifest.version}`,
      )
    const probe = join(work, "probe.mjs")
    await writeFile(
      probe,
      `import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent"
import { join } from "node:path"
const cwd = process.cwd()
const loaded = await discoverAndLoadExtensions(
  [join(cwd, "node_modules/@naxodev/pi-apnea/extension/index.ts")],
  cwd,
  join(cwd, "agent"),
)
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors))
const tools = loaded.extensions.flatMap(extension => [...extension.tools.values()])
for (const name of ["workflow_status", "workflow_wait", "dispatch_role"])
  if (!tools.some(tool => tool.definition.name === name)) throw new Error("Missing tool " + name)
if (!tools.every(tool => tool.definition.executionMode === "sequential"))
  throw new Error("Workflow tools must stay sequential")
const status = tools.find(tool => tool.definition.name === "workflow_status")
const result = await status.definition.execute("smoke-status", {}, new AbortController().signal, undefined, undefined)
if (result.details?.ok !== true || !result.content.some(part => part.type === "text" && part.text.includes("no active run")))
  throw new Error("Packed workflow_status did not report an idle workflow: " + JSON.stringify(result))
console.log("Packed tools registered; workflow_status executed without a model request.")
`,
    )
    await command(
      ["node", probe],
      work,
      "Pi SDK tool execution smoke",
      PACKAGE_SMOKE_TIMEOUTS.rpc,
      undefined,
      isolatedEnv,
    )
    // The marker proves the RPC host receives the temporary agent directory.
    const environmentProbe = join(work, "environment-probe.mjs")
    await writeFile(
      environmentProbe,
      `export default function(pi) {
  if (process.env.PI_CODING_AGENT_DIR !== ${JSON.stringify(isolatedEnv.PI_CODING_AGENT_DIR)})
    throw new Error("RPC host did not receive the isolated agent directory")
  pi.registerCommand("smoke-isolated-agent", { description: "Isolated host marker", handler: async () => {} })
}\n`,
    )
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
        "-e",
        environmentProbe,
      ],
      work,
      "Pi RPC package smoke",
      PACKAGE_SMOKE_TIMEOUTS.rpc,
      '{"type":"get_commands","id":"smoke"}\n',
      isolatedEnv,
    )
    const response = rpc.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((message) => message.id === "smoke")
    const commands = (response?.data as { commands?: Array<{ name?: string }> })
      ?.commands
    for (const name of [
      "apnea",
      "apnea-start",
      "apnea-status",
      "smoke-isolated-agent",
    ]) {
      if (!commands?.some((registered) => registered.name === name)) {
        throw new Error(`Pi did not load /${name} from the packed adapter`)
      }
    }
    console.log(
      `Installed ${basename(piArchive)} with packed core; Pi ${piVersion} loaded commands and executed workflow_status.`,
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main)
  await runPackageSmoke(
    process.argv
      .slice(2)
      .find((arg) => arg.startsWith("--pi-version="))
      ?.slice("--pi-version=".length),
  )
