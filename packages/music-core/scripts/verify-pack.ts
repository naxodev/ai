import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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

type Manifest = {
  exports?: Record<string, string>
  bin?: Record<string, string>
  engines?: { node?: string }
}
const packageDirectory = fileURLToPath(new URL("..", import.meta.url))
const manifest = (await Bun.file(
  join(packageDirectory, "package.json"),
).json()) as Manifest
if (manifest.exports?.["."] !== "./index.ts")
  throw new Error("package root export must point at index.ts")
if (manifest.bin?.["naxodev-music-sessiond"] !== "./dist/music-sessiond.js")
  throw new Error("package bin must point at dist/music-sessiond.js")

class ProcessGroupCleanupError extends Error {}

const waitForExit = async (
  child: ReturnType<typeof Bun.spawn>,
  label: string,
  timeoutMs: number,
) => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
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

const terminate = async (
  child: ReturnType<typeof Bun.spawn>,
  label: string,
  processGroup: boolean,
) => {
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    try {
      if (processGroup && process.platform !== "win32")
        process.kill(-child.pid, name)
      else child.kill(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  try {
    signal("SIGTERM")
    await waitForExit(child, `${label} termination`, 5_000)
    if (processGroup && process.platform !== "win32")
      await waitForProcessGroupExit(child.pid, label)
  } catch {
    signal("SIGKILL")
    await waitForExit(child, `${label} forced termination`, 5_000)
    if (processGroup && process.platform !== "win32")
      await waitForProcessGroupExit(child.pid, label)
  }
}

const captureOutput = (stream: ReadableStream<Uint8Array>) => {
  let text = ""
  const done = (async () => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
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

const command = async (
  args: string[],
  cwd: string,
  label: string,
  timeoutMs = 60_000,
  processGroup = false,
) => {
  const child = Bun.spawn(args, {
    cwd,
    detached: processGroup,
    stdout: "pipe",
    stderr: "pipe",
  })
  // Begin draining before waiting, so a verbose failed child cannot block on a full pipe.
  const stdout = captureOutput(child.stdout)
  const stderr = captureOutput(child.stderr)
  let exitCode: number
  try {
    exitCode = await waitForExit(child, label, timeoutMs)
  } catch (error) {
    try {
      await terminate(child, label, processGroup)
    } catch (terminationError) {
      await Promise.race([
        Promise.all([stdout.done, stderr.done]),
        Bun.sleep(1_000),
      ])
      throw new ProcessGroupCleanupError(
        `${label} timed out and its exact child did not exit: ${String(terminationError)}\nstdout:\n${stdout.text()}\nstderr:\n${stderr.text()}`,
        { cause: error },
      )
    }
    const [capturedOut, capturedErr] = await Promise.all([
      stdout.done,
      stderr.done,
    ])
    throw new Error(
      `${label} timed out\nstdout:\n${capturedOut}\nstderr:\n${capturedErr}`,
      { cause: error },
    )
  }
  const [capturedOut, capturedErr] = await Promise.all([
    stdout.done,
    stderr.done,
  ])
  if (exitCode !== 0) {
    if (processGroup) {
      try {
        await terminate(child, label, true)
      } catch (error) {
        await Promise.race([
          Promise.all([stdout.done, stderr.done]),
          Bun.sleep(1_000),
        ])
        throw new ProcessGroupCleanupError(
          `${label} failed and its process group did not exit: ${String(error)}\nstdout:\n${stdout.text()}\nstderr:\n${stderr.text()}`,
        )
      }
    }
    throw new Error(
      `${label} failed (exit ${exitCode})\nstdout:\n${capturedOut}\nstderr:\n${capturedErr}`,
    )
  }
  return capturedOut
}

const verifyDryPack = async () => {
  const output = await command(
    ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
    packageDirectory,
    "npm pack --dry-run",
  )
  const packs = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>
  const files = new Set(packs[0]?.files.map(({ path }) => path))
  for (const expected of expectedFiles)
    if (!files.has(expected))
      throw new Error(`npm package is missing ${expected}`)
  for (const file of files)
    if (!expectedFiles.has(file))
      throw new Error(`npm package contains unexpected file ${file}`)
  console.log(`Verified npm package contents (${files.size} files)`)
}

const inside = (path: string, parent: string) => {
  const result = relative(parent, path)
  return (
    result === "" || (!result.startsWith("..") && !result.startsWith("../"))
  )
}

const resolveNode = async () => {
  const output = await command(
    ["/usr/bin/env", "which", "node"],
    packageDirectory,
    "find node",
  )
  const executable = await realpath(output.trim())
  const version = (
    await command(
      [executable, "--version"],
      packageDirectory,
      "check node version",
    )
  ).trim()
  const minimum = manifest.engines?.node?.match(/^>=(\d+)\.(\d+)\.(\d+)$/)
  const actual = version.match(/^v(\d+)\.(\d+)\.(\d+)$/)
  if (!minimum || !actual)
    throw new Error("package node engine must be a >=major.minor.patch range")
  const atLeast = actual.slice(1).map(Number)
  const floor = minimum.slice(1).map(Number)
  if (
    atLeast[0]! < floor[0]! ||
    (atLeast[0] === floor[0] && atLeast[1]! < floor[1]!) ||
    (atLeast[0] === floor[0] &&
      atLeast[1] === floor[1] &&
      atLeast[2]! < floor[2]!)
  )
    throw new Error(
      `Node ${version} does not satisfy ${manifest.engines?.node}`,
    )
  return { executable, version }
}

const harnessSource = `
import { access, realpath, readdir, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import {
  baselineCapabilities,
  createReconnectingMusicSessionClient,
  PROTOCOL,
} from "@naxodev/music-core"

const [installRoot, runtimeRoot, expectedNode, emptyBin] = process.argv.slice(2)
const fail = (message) => { throw new Error(message) }
const inside = (path, parent) => {
  const result = relative(parent, path)
  return result === "" || (!result.startsWith("..") && !result.startsWith("../"))
}
const waitFor = async (predicate, label, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  fail("timed out waiting for " + label)
}
const bounded = (promise, label, timeoutMs = 10_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for " + label)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
const waitForExit = (child, timeoutMs = 10_000) => {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for daemon exit")), timeoutMs)
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
const terminateChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  try {
    await waitForExit(child, 5_000)
  } catch {
    child.kill("SIGKILL")
    await waitForExit(child, 5_000)
  }
}

let client
let clientAcquisition
let daemon
let invalidDaemon
let daemonExit
let daemonInstanceId = ""
let selectedRevision = 0
let daemonLog = ""
let cleaning = false
const cleanup = async () => {
  if (cleaning) return
  cleaning = true
  let failure
  const pendingAcquisition = !client && clientAcquisition ? clientAcquisition : undefined
  if (client) {
    try {
      await bounded(client.dispose(), "client disposal", 10_000)
      client = undefined
    } catch (error) {
      failure = error
    }
  }
  // A timed-out startup Promise has no cancellation API. Stop its exact daemon
  // boundary first, then await its terminal result and dispose any late client.
  for (const child of [invalidDaemon, daemon]) {
    try {
      if (child) await terminateChild(child)
    } catch (error) {
      failure ??= error
    }
  }
  if (pendingAcquisition) {
    try {
      client = await pendingAcquisition
      clientAcquisition = undefined
    } catch {
      // A failed acquisition is its terminal cleanup outcome after its daemon stopped.
      clientAcquisition = undefined
    }
    if (client) {
      try {
        await bounded(client.dispose(), "late client disposal", 10_000)
        client = undefined
      } catch (error) {
        // Keep the acquired client owned and prevent runtime-root removal.
        failure ??= error
      }
    }
  }
  if (failure) throw failure
  await rm(runtimeRoot, { recursive: true, force: true })
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => { void cleanup().finally(() => process.exit(1)) })
try {
  if ((await realpath(process.execPath)) !== expectedNode)
    fail("lifecycle harness is not running under the resolved Node executable")
  const rootEntry = await import.meta.resolve("@naxodev/music-core")
  const rootPath = await realpath(fileURLToPath(rootEntry))
  if (!inside(rootPath, installRoot)) fail("installed package root resolved outside temporary install")
  const installedPackage = dirname(rootPath)
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(join(installedPackage, "package.json"), "utf8"))
  if (manifest.exports?.["."] !== "./index.ts") fail("installed root export is invalid")
  const bin = manifest.bin?.["naxodev-music-sessiond"]
  if (typeof bin !== "string") fail("installed manifest has no daemon bin")
  const daemonPath = await realpath(join(installedPackage, bin))
  if (!inside(daemonPath, installedPackage)) fail("manifest-selected daemon escaped installed package")
  await (await import("node:fs/promises")).mkdir(runtimeRoot, { recursive: true })
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || uid < 0) fail("Node did not provide a numeric UID")
  const runtime = {
    directory: join(runtimeRoot, "naxodev-music-" + uid),
    socketPath: join(runtimeRoot, "naxodev-music-" + uid, "s.sock"),
    markerPath: join(runtimeRoot, "naxodev-music-" + uid, "start.lock"),
    uid,
  }
  if (!inside(runtime.directory, runtimeRoot)) fail("managed runtime escaped temporary root")
  invalidDaemon = spawn(process.execPath, [daemonPath, "--socket", runtime.socketPath, "--idle-grace-ms", "0"], {
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: emptyBin },
  })
  let invalidLog = ""
  invalidDaemon.stderr.setEncoding("utf8")
  invalidDaemon.stderr.on("data", (chunk) => { invalidLog += chunk })
  const invalidExit = await waitForExit(invalidDaemon, 5_000)
  if (invalidExit.code !== 1 || !invalidLog.includes("positive safe integer"))
    fail("invalid idle grace did not fail through daemon config status")
  for (const artifact of [runtime.socketPath, runtime.markerPath, runtime.socketPath + ".bind-lock"])
    await access(artifact).then(() => fail("invalid daemon retained runtime artifact"), (error) => {
      if (error?.code !== "ENOENT") throw error
    })
  clientAcquisition = createReconnectingMusicSessionClient({
    clientId: "installed-package-smoke",
    hostKind: "test",
    capabilities: [...baselineCapabilities],
    runtime,
    startup: { attempts: 20, initialDelayMs: 25, maxDelayMs: 100 },
    launcher: async () => {
      if (daemon) fail("launcher attempted to start more than one daemon")
      daemon = spawn(process.execPath, [daemonPath, "--socket", runtime.socketPath, "--idle-grace-ms", "250"], {
        shell: false,
        detached: false,
        stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: emptyBin },
      })
      daemon.stderr.setEncoding("utf8")
      daemon.stderr.on("data", (chunk) => { daemonLog += chunk })
      await new Promise((resolve, reject) => {
        daemon.once("spawn", resolve)
        daemon.once("error", reject)
      })
    },
  })
  client = await bounded(clientAcquisition, "client startup")
  clientAcquisition = undefined
  await waitFor(
    () => Boolean(client.daemonInstanceId && client.state && client.status),
    "hello and replay",
  )
  if (
    client.selectedRevision < PROTOCOL.minRevision ||
    client.selectedRevision > PROTOCOL.maxRevision
  ) fail("daemon selected an unsupported protocol revision")
  for (const capability of ["state-replay", "transport"])
    if (!client.negotiatedCapabilities.includes(capability))
      fail("daemon omitted negotiated capability " + capability)
  if (client.state.daemonInstanceId !== client.daemonInstanceId)
    fail("replayed state belongs to a different daemon instance")
  daemonInstanceId = client.daemonInstanceId
  selectedRevision = client.selectedRevision
  if (!daemon) fail("launcher did not retain daemon child")
  await bounded(client.dispose(), "client disposal")
  client = undefined
  daemonExit = await waitForExit(daemon)
  if (daemonExit.code !== 0 || daemonExit.signal)
    fail("daemon did not exit zero through idle shutdown: " + JSON.stringify(daemonExit))
  for (const diagnostic of ["listening", "idle shutdown", "stopped"])
    if (!daemonLog.includes(diagnostic)) fail("missing daemon diagnostic: " + diagnostic)
  if (daemonLog.includes("artwork") || daemonLog.includes('"track"'))
    fail("daemon diagnostics included playback or artwork payloads")
  for (const artifact of [runtime.socketPath, runtime.markerPath, runtime.socketPath + ".bind-lock"])
    await access(artifact).then(() => fail("owned runtime artifact remained"), (error) => {
      if (error?.code !== "ENOENT") throw error
    })
  const entries = await readdir(runtime.directory)
  if (entries.some((entry) => entry.startsWith("s.sock.bind-lock.") || entry.startsWith("start.lock.")))
    fail("owned runtime temporary remained")
  console.log("installed package root: " + rootPath)
  console.log("manifest daemon: " + daemonPath)
  console.log("negotiated daemon: " + daemonInstanceId + " revision " + selectedRevision)
  console.log("status-zero idle exit and cleanup: ok")
} catch (error) {
  if (daemonLog) console.error("daemon diagnostics:\\n" + daemonLog)
  throw error
} finally {
  await cleanup()
}
`

const nodeLoaderSource = `
import { readFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"

export async function load(url, context, nextLoad) {
  if (url.includes("/node_modules/@naxodev/music-core/") && url.endsWith(".ts")) {
    const source = await readFile(new URL(url), "utf8")
    return {
      format: "module",
      source: stripTypeScriptTypes(source, { mode: "transform", sourceMap: false }),
      shortCircuit: true,
    }
  }
  return nextLoad(url, context)
}
`

const installedSmoke = async () => {
  const root = await mkdtemp("/tmp/music-core-installed-smoke-")
  let retainRoot = false
  try {
    await command(
      [process.execPath, "run", "build"],
      packageDirectory,
      "build package",
    )
    const packed = await command(
      ["npm", "pack", "--ignore-scripts", "--pack-destination", root],
      packageDirectory,
      "pack package",
    )
    const archive = resolve(root, packed.trim().split("\n").at(-1) ?? "")
    if (!archive.startsWith(root) || !archive.endsWith(".tgz"))
      throw new Error("npm pack did not create its archive in the smoke root")
    const install = join(root, "install")
    await mkdir(install)
    await writeFile(
      join(install, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "@naxodev/music-core": `file:${archive}` },
      }),
    )
    await writeFile(join(install, "harness.mjs"), harnessSource)
    await writeFile(join(install, "typescript-loader.mjs"), nodeLoaderSource)
    await command(
      ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
      install,
      "install packed package",
    )
    const { executable, version } = await resolveNode()
    const installRoot = await realpath(install)
    const installedRoot = await realpath(
      join(installRoot, "node_modules", "@naxodev", "music-core"),
    )
    if (
      !inside(installedRoot, installRoot) ||
      inside(installedRoot, packageDirectory)
    )
      throw new Error(
        `packed package resolved outside temporary install: ${installedRoot}`,
      )
    const runtimeRoot = join(await realpath(root), "runtime")
    const emptyBin = join(await realpath(root), "empty-bin")
    await mkdir(emptyBin)
    const output = await command(
      [
        executable,
        "--experimental-loader",
        join(install, "typescript-loader.mjs"),
        join(install, "harness.mjs"),
        installRoot,
        runtimeRoot,
        executable,
        emptyBin,
      ],
      install,
      "installed Node lifecycle harness",
      30_000,
      true,
    )
    console.log(`installed Node ${version}`)
    console.log(output.trim())
  } catch (error) {
    if (error instanceof ProcessGroupCleanupError) {
      retainRoot = true
      console.error(`retained unconfirmed smoke root: ${root}`)
    }
    throw error
  } finally {
    if (!retainRoot) await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes("--installed-smoke")) await installedSmoke()
else await verifyDryPack()
