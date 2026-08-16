import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const expectedCommands = ["music", "music-next", "music-prev"]
const packageDirectory = fileURLToPath(new URL("..", import.meta.url))
const coreDirectory = fileURLToPath(new URL("../../music-core/", import.meta.url))
type SourceManifest = {
  readonly devDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
}
const sourceManifest = (await Bun.file(
  join(packageDirectory, "package.json"),
).json()) as SourceManifest
const piPackages = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const

const parseVersion = (value: string | undefined, label: string) => {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) throw new Error(`${label} must be an exact major.minor.patch pin`)
  return match.slice(1).map(Number) as [number, number, number]
}
const compareVersions = (
  left: readonly number[],
  right: readonly number[],
) => {
  for (let index = 0; index < left.length; index++) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}
const requirePeerCompatible = (pin: string, range: string, label: string) => {
  const bounds = range.match(/^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/)
  if (!bounds)
    throw new Error(`${label} peer range must be a >=version <version range`)
  const version = parseVersion(pin, `${label} tested pin`)
  const lower = parseVersion(bounds[1], `${label} peer lower bound`)
  const upper = parseVersion(bounds[2], `${label} peer upper bound`)
  if (compareVersions(version, lower) < 0 || compareVersions(version, upper) >= 0)
    throw new Error(`${label} tested pin ${pin} is outside peer range ${range}`)
}
const piVersions = Object.fromEntries(
  piPackages.map((name) => {
    const pin = sourceManifest.devDependencies?.[name]
    const range = sourceManifest.peerDependencies?.[name]
    parseVersion(pin, `${name} development dependency`)
    if (!range) throw new Error(`${name} peer range is missing`)
    requirePeerCompatible(pin!, range, name)
    return [name, { pin: pin!, range }]
  }),
) as Record<(typeof piPackages)[number], { pin: string; range: string }>

const root = await mkdtemp(join(tmpdir(), "pi-music-dock-smoke-"))
const requestedArchive = process.argv[2]
const output = (result: ReturnType<typeof Bun.spawnSync>) =>
  `stdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
const inside = (path: string, parent: string) => {
  const result = relative(parent, path)
  return result === "" || (!result.startsWith("..") && !result.startsWith("../"))
}
const archiveFromPack = async (directory: string, label: string) => {
  const packed = Bun.spawnSync(
    ["npm", "pack", "--silent", "--pack-destination", root],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  )
  if (!packed.success) throw new Error(`${label} pack failed: ${output(packed)}`)
  const name = packed.stdout.toString().trim().split("\n").at(-1)
  if (!name) throw new Error(`${label} pack did not produce an archive`)
  const archive = await realpath(resolve(root, name))
  if (!inside(archive, await realpath(root)) || !archive.endsWith(".tgz"))
    throw new Error(`${label} archive escaped the smoke root: ${archive}`)
  return archive
}
const waitForExit = async (
  child: ReturnType<typeof Bun.spawn>,
  label: string,
  timeoutMs: number,
) => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
const waitForProcessGroupExit = async (pid: number, label: string) => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return
      throw error
    }
    await Bun.sleep(25)
  }
  throw new Error(`${label} process group did not exit`)
}
const terminateProcessGroup = async (
  child: ReturnType<typeof Bun.spawn>,
  label: string,
) => {
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-child.pid, name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  try {
    signal("SIGTERM")
    await waitForExit(child, `${label} SIGTERM`, 5_000)
    await waitForProcessGroupExit(child.pid, label)
  } catch {
    signal("SIGKILL")
    await waitForExit(child, `${label} SIGKILL`, 5_000)
    await waitForProcessGroupExit(child.pid, label)
  }
}
const captureOutput = (stream: ReadableStream<Uint8Array>) => {
  let text = ""
  const done = (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const next = await reader.read()
      if (next.done) {
        text += decoder.decode()
        return text
      }
      text += decoder.decode(next.value, { stream: true })
    }
  })()
  return { done, text: () => text }
}
const captureAvailable = async (
  capture: ReturnType<typeof captureOutput>,
  label: string,
) =>
  await Promise.race([
    capture.done,
    Bun.sleep(1_000).then(
      () => `${capture.text()}\n[${label} remained open after 1000ms]`,
    ),
  ])
const ownedCoreProcesses = (coreRoot: string) => {
  const processes = Bun.spawnSync(
    ["/bin/ps", "-axww", "-o", "pid=,ppid=,command="],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (!processes.success)
    throw new Error(`could not inspect owned processes: ${output(processes)}`)
  return processes.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(coreRoot))
}
const requireNoOwnedCoreProcess = (coreRoot: string) => {
  const processes = ownedCoreProcesses(coreRoot)
  if (processes.length > 0)
    throw new Error(
      `isolated music core left a daemon/provider process:\n${processes.join("\n")}`,
    )
}

let child: ReturnType<typeof Bun.spawn> | undefined
let ownedCoreRoot: string | undefined
let workFailure: unknown
let cleanupFailure: unknown
let summary:
  | {
      readonly pi: string
      readonly dockRoot: string
      readonly coreRoot: string
    }
  | undefined
try {
  const archive = requestedArchive
    ? await realpath(resolve(requestedArchive))
    : await archiveFromPack(packageDirectory, "Pi music dock")
  const coreArchive = await archiveFromPack(coreDirectory, "music-core")
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "@naxodev/music-core": `file:${coreArchive}`,
        "@naxodev/pi-music-dock": `file:${archive}`,
        "@earendil-works/pi-coding-agent":
          piVersions["@earendil-works/pi-coding-agent"].pin,
        "@earendil-works/pi-tui": piVersions["@earendil-works/pi-tui"].pin,
      },
      overrides: {
        "@naxodev/music-core": `file:${coreArchive}`,
      },
    }),
  )
  const install = Bun.spawnSync(["bun", "install", "--ignore-scripts", "--silent"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!install.success) throw new Error(`package install failed: ${output(install)}`)

  const nodeModules = await realpath(join(root, "node_modules"))
  const installedManifest = async (name: string) =>
    (await Bun.file(join(nodeModules, name, "package.json")).json()) as {
      name?: string
      version?: string
      bin?: { pi?: string }
      pi?: { extensions?: string[] }
      peerDependencies?: Record<string, string>
    }
  const [piManifest, tuiManifest, dockManifest] = await Promise.all([
    installedManifest("@earendil-works/pi-coding-agent"),
    installedManifest("@earendil-works/pi-tui"),
    installedManifest("@naxodev/pi-music-dock"),
  ])
  for (const [name, manifest] of [
    ["@earendil-works/pi-coding-agent", piManifest],
    ["@earendil-works/pi-tui", tuiManifest],
  ] as const) {
    const { pin, range } = piVersions[name]
    if (manifest.version !== pin)
      throw new Error(`installed ${name} is ${manifest.version}, expected ${pin}`)
    requirePeerCompatible(manifest.version, range, `installed ${name}`)
  }
  if (dockManifest.name !== "@naxodev/pi-music-dock")
    throw new Error(`unexpected packed package name: ${dockManifest.name}`)
  if (dockManifest.pi?.extensions?.join(",") !== "./extensions")
    throw new Error("packed manifest does not expose ./extensions to Pi")
  for (const [name, manifest] of [
    ["@earendil-works/pi-coding-agent", piManifest],
    ["@earendil-works/pi-tui", tuiManifest],
  ] as const) {
    const range = dockManifest.peerDependencies?.[name]
    if (!range) throw new Error(`packed manifest has no ${name} peer range`)
    requirePeerCompatible(manifest.version!, range, `packed ${name}`)
  }

  const [dockRoot, coreRoot, piRoot, sourceDock, sourceCore] = await Promise.all([
    realpath(join(nodeModules, "@naxodev", "pi-music-dock")),
    realpath(join(nodeModules, "@naxodev", "music-core")),
    realpath(join(nodeModules, "@earendil-works", "pi-coding-agent")),
    realpath(packageDirectory),
    realpath(coreDirectory),
  ])
  for (const [label, installed] of [
    ["music dock", dockRoot],
    ["music core", coreRoot],
  ] as const)
    if (
      !inside(installed, nodeModules) ||
      inside(installed, sourceDock) ||
      inside(installed, sourceCore)
    )
      throw new Error(`packed ${label} resolved outside isolated install: ${installed}`)

  if (ownedCoreProcesses(coreRoot).length > 0)
    throw new Error(`isolated music core was already running from ${coreRoot}`)
  ownedCoreRoot = coreRoot

  const piBin = await realpath(join(nodeModules, ".bin", "pi"))
  const manifestBin = piManifest.bin?.pi
  if (!manifestBin) throw new Error("installed Pi manifest has no pi bin entry")
  const manifestPiBin = await realpath(join(piRoot, manifestBin))
  if (piBin !== manifestPiBin)
    throw new Error(`isolated .bin/pi disagrees with installed Pi manifest: ${piBin}`)
  if (!inside(piBin, piRoot))
    throw new Error(`isolated Pi binary escaped its package: ${piBin}`)
  const version = Bun.spawnSync([piBin, "--version"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const expectedPiVersion = piVersions["@earendil-works/pi-coding-agent"].pin
  if (!version.success || version.stdout.toString().trim() !== expectedPiVersion)
    throw new Error(
      `installed Pi binary did not report ${expectedPiVersion} at ${piBin}: ${output(version)}`,
    )

  child = Bun.spawn(
    [
      piBin,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "-e",
      dockRoot,
    ],
    {
      cwd: root,
      detached: true,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(root, "pi"),
        PI_OFFLINE: "1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stdout = captureOutput(child.stdout)
  const stderr = captureOutput(child.stderr)
  let exitCode: number
  try {
    child.stdin.write('{"type":"get_commands","id":"smoke"}\n')
    child.stdin.end()
    exitCode = await waitForExit(child, "Pi RPC host", 10_000)
    await waitForProcessGroupExit(child.pid, "Pi RPC host")
    requireNoOwnedCoreProcess(coreRoot)
  } catch (error) {
    let termination: unknown
    try {
      await terminateProcessGroup(child, "Pi RPC host")
    } catch (terminationError) {
      termination = terminationError
    }
    const [capturedOut, capturedErr] = await Promise.all([
      captureAvailable(stdout, "Pi stdout"),
      captureAvailable(stderr, "Pi stderr"),
    ])
    throw new Error(
      `Pi RPC lifecycle failed\nstdout:\n${capturedOut}\nstderr:\n${capturedErr}${termination ? `\ntermination: ${String(termination)}` : ""}`,
      { cause: error },
    )
  }
  const [capturedOut, capturedErr] = await Promise.all([
    stdout.done,
    stderr.done,
  ])
  if (exitCode !== 0)
    throw new Error(`Pi exited ${exitCode}\nstdout:\n${capturedOut}\nstderr:\n${capturedErr}`)

  const response = capturedOut
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((message) => message.id === "smoke")
  if (
    response?.type !== "response" ||
    response.command !== "get_commands" ||
    response.success !== true
  )
    throw new Error(`Pi did not return a successful get_commands response: ${capturedOut}`)
  const data = response.data as
    | { commands?: Array<{ name?: string; source?: string }> }
    | undefined
  const commands = data?.commands?.filter(
    (command) => command.source === "extension",
  )
  for (const name of expectedCommands)
    if (!commands?.some((command) => command.name === name))
      throw new Error(`Pi did not load /${name} from the packed package`)

  summary = {
    pi: piBin,
    dockRoot,
    coreRoot,
  }
} catch (error) {
  workFailure = error
} finally {
  try {
    if (child) {
      try {
        await waitForProcessGroupExit(child.pid, "Pi RPC host")
      } catch {
        await terminateProcessGroup(child, "Pi RPC host")
      }
    }
    if (ownedCoreRoot) requireNoOwnedCoreProcess(ownedCoreRoot)
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    cleanupFailure = error
    console.error(`retained unconfirmed Pi smoke root: ${root}`)
  }
}

if (workFailure && cleanupFailure)
  throw new Error(
    `${workFailure instanceof Error ? workFailure.message : String(workFailure)}\nCleanup failure: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`,
    { cause: workFailure },
  )
if (workFailure) throw workFailure
if (cleanupFailure) throw cleanupFailure
if (!summary) throw new Error("Pi package smoke completed without a summary")
console.log(
  `installed Pi ${piVersions["@earendil-works/pi-coding-agent"].pin}: ${summary.pi}`,
)
console.log(
  `isolated packed roots: music-dock=${summary.dockRoot}; music-core=${summary.coreRoot}`,
)
console.log(`Pi registered extension commands: ${expectedCommands.map((name) => `/${name}`).join(", ")}`)
console.log("Pi RPC status-zero exit and cleanup: ok")
