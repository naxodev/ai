import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-process.ts"

const CORE = "@naxodev/music-core"
const REGISTRY = "https://registry.npmjs.org"
const hosts = ["opencode-music-player", "pi-music-dock"] as const
type Host = (typeof hosts)[number]
type Manifest = {
  name: string
  version: string
  dependencies: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}
const manifestAt = async (directory: string): Promise<Manifest> =>
  JSON.parse(await readFile(join(directory, "package.json"), "utf8"))

export function checkStagedCore(
  host: string,
  range: string,
  version: string,
): void {
  if (!range || !Bun.semver.satisfies(version, range))
    throw new Error(
      `${host}: staged ${CORE}@${version} does not satisfy declared range ${range}. Update the host dependency range before releasing.`,
    )
}

export async function checkPublishedCore(
  range: string,
  options: {
    run?: BoundedCommandRunner
    attempts?: number
    retryDelayMs?: number
    registry?: string
  } = {},
): Promise<string> {
  const run = options.run ?? runBoundedCommand
  const attempts = options.attempts ?? 10
  const delay = options.retryDelayMs ?? 5_000
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    !Number.isFinite(delay) ||
    delay < 0
  )
    throw new Error("Invalid registry retry budget")
  let diagnostic = "No compatible version returned"
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await run(
        [
          "npm",
          "view",
          CORE,
          "versions",
          "--json",
          `--registry=${options.registry ?? REGISTRY}`,
          "--fetch-retries=0",
        ],
        { label: `npm view ${CORE}`, timeoutMs: 15_000 },
      )
      if (result.exitCode !== 0)
        throw new Error(result.stderr || "npm view failed")
      const value: unknown = JSON.parse(result.stdout)
      const versions = typeof value === "string" ? [value] : value
      if (
        !Array.isArray(versions) ||
        !versions.every((v) => typeof v === "string")
      )
        throw new Error("Invalid registry versions response")
      const version = versions.find((v) => Bun.semver.satisfies(v, range))
      if (version) return version
      diagnostic = `Visible versions: ${versions.join(", ") || "none"}`
    } catch (error) {
      diagnostic = String(error)
    }
    if (attempt < attempts) await Bun.sleep(delay)
  }
  throw new Error(
    `No published ${CORE} satisfies ${range} after ${attempts} attempts. Publish a compatible ${CORE} first, wait for registry propagation, then rerun the host release. ${diagnostic}`,
  )
}

export async function checkRegistryConsumer(
  host: Host,
  directory: string,
  run: BoundedCommandRunner = runBoundedCommand,
): Promise<string> {
  const manifest = await manifestAt(directory)
  const range = manifest.dependencies[CORE]
  const root = await mkdtemp(join(tmpdir(), "music-registry-consumer-"))
  const command = async (args: string[], cwd: string, timeoutMs: number) => {
    const result = await run(args, {
      cwd,
      label: `${host}: ${args.slice(0, 2).join(" ")}`,
      timeoutMs,
    })
    if (result.exitCode !== 0)
      throw new Error(
        `${host}: consumer command failed: ${result.stdout}\n${result.stderr}`,
      )
    return result.stdout
  }
  try {
    const packed = JSON.parse(
      await command(
        ["npm", "pack", "--json", "--pack-destination", root],
        directory,
        30_000,
      ),
    ) as { filename: string }[]
    const filename = packed[0]?.filename
    if (
      !filename ||
      basename(filename) !== filename ||
      !filename.endsWith(".tgz")
    )
      throw new Error("Invalid npm pack archive")
    const dependencies: Record<string, string> = {
      [manifest.name]: `file:${join(root, filename)}`,
    }
    // Pin the supported Pi host, but let its packed extension resolve music-core.
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      const pin = manifest.devDependencies?.[peer]
      if (!pin) throw new Error(`Missing tested peer pin: ${peer}`)
      dependencies[peer] = pin
    }
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies }),
    )
    await command(
      [
        "npm",
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--workspaces=false",
        `--registry=${REGISTRY}`,
        "--fetch-retries=0",
        "--fetch-timeout=30000",
        "--cache",
        join(root, "npm-cache"),
      ],
      root,
      180_000,
    )
    const installedHost = join(root, "node_modules", manifest.name)
    const packedManifest = await manifestAt(installedHost)
    if (packedManifest.dependencies[CORE] !== range)
      throw new Error("Packed core dependency range changed")
    const entry =
      host === "pi-music-dock" ? "extensions/music-dock/index.ts" : "index.tsx"
    // Resolve from the installed host, including any nested dependency installation.
    const probe = `import { realpathSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
const hostEntry = ${JSON.stringify(join(installedHost, entry))}
const coreEntry = realpathSync(fileURLToPath(import.meta.resolve(${JSON.stringify(CORE)}, hostEntry)))
let coreRoot = dirname(coreEntry)
while (!await Bun.file(join(coreRoot, "package.json")).exists()) coreRoot = dirname(coreRoot)
const manifest = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8"))
if (manifest.name !== ${JSON.stringify(CORE)} || !Bun.semver.satisfies(manifest.version, ${JSON.stringify(range)})) throw new Error("Installed core violates declared range")
${
  host === "opencode-music-player"
    ? `import plugin from ${JSON.stringify(join(installedHost, entry))}
if (plugin.id !== "music-player" || typeof plugin.setup !== "function") throw new Error("Invalid music plugin")`
    : `import extension from ${JSON.stringify(join(installedHost, entry))}
const commands = []
extension({ on() {}, registerShortcut() {}, registerCommand(name) { commands.push(name) } })
if (!["music", "music-next", "music-prev", "music-view", "music-focus"].every(name => commands.includes(name))) throw new Error("Missing music commands")`
}
console.log(JSON.stringify({ version: manifest.version, coreEntry }))`
    await writeFile(join(root, "probe.ts"), probe)
    const output = await command(
      [process.execPath, join(root, "probe.ts")],
      root,
      30_000,
    )
    const result = JSON.parse(output.trim()) as {
      version: string
      coreEntry: string
    }
    const path = relative(
      await realpath(join(root, "node_modules")),
      await realpath(result.coreEntry),
    )
    if (path.startsWith("..") || isAbsolute(path))
      throw new Error("Core resolved outside isolated consumer")
    return `${host}: registry ${CORE}@${result.version} satisfies ${range}; host loaded from isolated tarball; core=${result.coreEntry}`
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const host = process.argv[2] as Host
  if (!hosts.includes(host))
    throw new Error(`Expected host: ${hosts.join(", ")}`)
  const directory = resolve(import.meta.dir, "../packages", host)
  const manifest = await manifestAt(directory)
  const core = await manifestAt(
    resolve(import.meta.dir, "../packages/music-core"),
  )
  checkStagedCore(host, manifest.dependencies[CORE]!, core.version)
  if (process.argv[3] !== "--staged-only") {
    await checkPublishedCore(manifest.dependencies[CORE]!)
    console.log(await checkRegistryConsumer(host, directory))
  }
}
