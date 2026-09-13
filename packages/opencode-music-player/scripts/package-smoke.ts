import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  checkOpenCodeCompatibility,
  compatibility,
  hostDependencies,
} from "../../../scripts/opencode-compatibility.ts"
import { packedRegistry } from "../../../scripts/packed-registry.ts"

const packageDirectory = fileURLToPath(new URL("..", import.meta.url))
const coreDirectory = fileURLToPath(
  new URL("../../music-core/", import.meta.url),
)
await checkOpenCodeCompatibility()
const openCodePin = compatibility.host.version
const expectedOpenCode = `${compatibility.host.binary} v${openCodePin}`
const root = await mkdtemp(join(tmpdir(), "opencode-music-player-smoke-"))
const socket = `opencode-music-player-smoke-${process.pid}-${crypto.randomUUID()}`
const session = "smoke"

const output = (result: ReturnType<typeof Bun.spawnSync>) =>
  `stdout:\n${result.stdout?.toString() ?? ""}\nstderr:\n${result.stderr?.toString() ?? ""}`
const inside = (path: string, parent: string) => {
  const result = relative(parent, path)
  return (
    result === "" || (!result.startsWith("..") && !result.startsWith("../"))
  )
}
const stripAnsi = (value: string) =>
  value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replaceAll("\r", "")
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", "-L", socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
const capturePane = () => {
  const captured = tmux("capture-pane", "-p", "-e", "-t", session)
  return stripAnsi(captured.stdout.toString())
}
const occurrences = (value: string, marker: string) =>
  value.split(marker).length - 1
const archiveFromPack = async (directory: string, label: string) => {
  const packed = Bun.spawnSync(
    ["npm", "pack", "--silent", "--pack-destination", root],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  )
  if (!packed.success)
    throw new Error(`${label} pack failed: ${output(packed)}`)
  const name = packed.stdout.toString().trim().split("\n").at(-1)
  if (!name) throw new Error(`${label} pack did not produce an archive`)
  const archive = resolve(root, name)
  const resolvedRoot = await realpath(root)
  const resolvedArchive = await realpath(archive)
  if (
    !inside(resolvedArchive, resolvedRoot) ||
    !resolvedArchive.endsWith(".tgz")
  )
    throw new Error(
      `${label} pack archive escaped smoke root: ${resolvedArchive}`,
    )
  return resolvedArchive
}
const tmuxServerState = () => {
  const inspected = tmux("list-sessions")
  if (inspected.success) return "running" as const
  const diagnostics = output(inspected)
  if (
    /no server running|error connecting to .*\(No such file or directory\)/i.test(
      diagnostics,
    )
  )
    return "absent" as const
  throw new Error(
    `could not confirm exact tmux server state for ${socket}: ${diagnostics}`,
  )
}
const terminateTmux = async () => {
  if (tmuxServerState() === "absent") return
  const killed = tmux("kill-server")
  if (!killed.success) {
    if (tmuxServerState() === "absent") return
    throw new Error(`exact tmux cleanup failed: ${output(killed)}`)
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (tmuxServerState() === "absent") return
    await Bun.sleep(25)
  }
  throw new Error(`exact tmux server did not terminate: ${socket}`)
}

let workFailure: unknown
let registry: Awaited<ReturnType<typeof packedRegistry>> | undefined
let cleanupFailure: unknown
let summary:
  | {
      readonly binary: string
      readonly pluginEntry: string
      readonly coreEntry: string
    }
  | undefined
try {
  const archive = await archiveFromPack(packageDirectory, "OpenCode plugin")
  const coreArchive = await archiveFromPack(coreDirectory, "music-core")
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "@naxodev/music-core": `file:${coreArchive}`,
        "@naxodev/opencode-music-player": `file:${archive}`,
        [compatibility.host.package]: openCodePin,
      },
    }),
  )

  const install = Bun.spawnSync(
    ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: root,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (!install.success)
    throw new Error(`package install failed: ${output(install)}`)

  // Execute only the exact CLI's platform-executable installation hook.
  const cliHook = Bun.spawnSync(
    [
      "node",
      join(root, "node_modules", compatibility.host.package, "postinstall.mjs"),
    ],
    { cwd: root, timeout: 30_000, stdout: "pipe", stderr: "pipe" },
  )
  if (!cliHook.success)
    throw new Error(`CLI installation hook failed: ${output(cliHook)}`)

  const nodeModules = await realpath(join(root, "node_modules"))
  const installedManifest = async (name: string) =>
    (await Bun.file(join(nodeModules, name, "package.json")).json()) as {
      version?: string
    }
  const cliManifest = await installedManifest(compatibility.host.package)
  if (cliManifest.version !== openCodePin)
    throw new Error(
      `installed OpenCode version does not match ${openCodePin}: cli=${cliManifest.version}`,
    )

  const openCodeBinary = await realpath(
    join(nodeModules, ".bin", compatibility.host.binary),
  )
  if (!inside(openCodeBinary, nodeModules))
    throw new Error(
      `installed OpenCode binary escaped temporary install: ${openCodeBinary}`,
    )
  const version = Bun.spawnSync([openCodeBinary, "--version"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!version.success || version.stdout.toString().trim() !== expectedOpenCode)
    throw new Error(
      `installed OpenCode binary did not report ${expectedOpenCode} at ${openCodeBinary}: ${output(version)}`,
    )

  const resolved = Bun.spawnSync(
    [
      "bun",
      "-e",
      `console.log(JSON.stringify({ plugin: import.meta.resolve("@naxodev/opencode-music-player"), core: import.meta.resolve("@naxodev/music-core") }))`,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  )
  if (!resolved.success)
    throw new Error(`isolated package resolution failed: ${output(resolved)}`)
  for (const name of Object.keys(hostDependencies)) {
    if (await Bun.file(join(nodeModules, name, "package.json")).exists())
      throw new Error(
        `Host-provided ${name} must not be installed in the smoke consumer`,
      )
  }
  const paths = JSON.parse(resolved.stdout.toString()) as {
    plugin: string
    core: string
  }
  const pluginEntry = await realpath(fileURLToPath(paths.plugin))
  const coreEntry = await realpath(fileURLToPath(paths.core))
  const sourceDirectories = await Promise.all([
    realpath(packageDirectory),
    realpath(coreDirectory),
  ])
  for (const [label, entry] of [
    ["plugin", pluginEntry],
    ["core", coreEntry],
  ] as const)
    if (
      !inside(entry, nodeModules) ||
      sourceDirectories.some((source) => inside(entry, source))
    )
      throw new Error(
        `isolated ${label} resolved outside packed install: ${entry}`,
      )

  const packageDir = join(nodeModules, "@naxodev", "opencode-music-player")
  const packageEntry = join(packageDir, "dist", "index.js")
  const originalEntry = join(packageDir, "dist", "index.original.js")
  await rename(packageEntry, originalEntry)
  const fixtureSource = `import { appendFileSync, existsSync } from "node:fs"
import { createController, createMusicPlayerPlugin } from "./index.original.js"

const track = {
  uri: "system:smoke-track",
  id: "smoke-track",
  name: "SMOKE COMPACT TRACK MARKER",
  artists: "SMOKE COMPACT ARTIST MARKER",
  album: "Smoke album",
  duration_ms: 245000,
  artwork: null,
  artwork_loading: true,
}
const artwork = {
  id: "smoke-cover",
  png_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  accent: "#7aa2f7",
  cells: [[{ upper: "#7aa2f7", lower: "#1a1b26" }]],
}
let playing = true
const exercisePlaybackTransitions = playing
let progressMs = 123000
let publishSnapshot = () => {}
let publishArtwork = () => {}
const mountedSlots = new Set()
const updateTimers = []
let updatesScheduled = false
let pausePublished = false
let resumePublished = false

const scheduleUpdates = () => {
  if (updatesScheduled || mountedSlots.size < 2) return
  updatesScheduled = true
  updateTimers.push(setTimeout(() => publishSnapshot(), 100))
  updateTimers.push(setTimeout(() => publishArtwork(), 300))
  updateTimers.push(
    setTimeout(() => {
      progressMs = 124000
      publishSnapshot()
    }, 500),
  )
  updateTimers.push(
    setTimeout(() => {
      progressMs = 125000
      publishSnapshot()
      appendFileSync(process.env.OPENCODE_MUSIC_FINAL_SNAPSHOT, "")
    }, 700),
  )
  if (exercisePlaybackTransitions) {
    updateTimers.push(
      setInterval(() => {
        if (
          !pausePublished &&
          existsSync(process.env.OPENCODE_MUSIC_PAUSE_TRIGGER)
        ) {
          pausePublished = true
          progressMs = 130000
          playing = false
          publishSnapshot()
        }
        if (
          pausePublished &&
          !resumePublished &&
          existsSync(process.env.OPENCODE_MUSIC_RESUME_TRIGGER)
        ) {
          resumePublished = true
          playing = true
          publishSnapshot()
        }
      }, 50),
    )
  }
}

const player = () => ({
  track,
  is_playing: playing,
  progress_ms: progressMs,
  shuffle: false,
  repeat: "off",
  device: null,
  fetched_at: Date.now(),
})

const plugin = createMusicPlayerPlugin({
  createController: (context) => {
    return createController(context, {
      createSessionMedia: () => ({
        player: async () => null,
        play: async () => { playing = true },
        pause: async () => { playing = false },
        next: async () => {},
        previous: async () => {},
        seek: async () => {},
        subscribe: (listener) => {
          publishSnapshot = () => listener({ type: "snapshot", state: player() })
          return () => { publishSnapshot = () => {} }
        },
        subscribePresentation: (listener) => {
          publishArtwork = () => listener({
            type: "artwork-completion",
            identity: {
              uid: track.id,
              title: track.name,
              artist: track.artists,
              album: track.album,
              duration_ms: track.duration_ms,
            },
            artwork,
            duration_ms: track.duration_ms,
          })
          return () => { publishArtwork = () => {} }
        },
        dispose: async () => {},
      }),
    })
  },
})

export default {
  ...plugin,
  async setup(context) {
    const graphicsTrace = process.env.OPENCODE_MUSIC_GRAPHICS_TRACE
    const fixtureRenderer = new Proxy(context.renderer, {
      get(target, property) {
        if (property === "capabilities")
          return { ...target.capabilities, kitty_graphics: true }
        if (property === "stdout") return {}
        if (property === "realStdoutWrite")
          return (data) => {
            appendFileSync(graphicsTrace, data)
            return true
          }
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const fixtureContext = {
      ...context,
      renderer: fixtureRenderer,
      ui: {
        ...context.ui,
        slot(claim) {
          return context.ui.slot({
            ...claim,
            render(props) {
              mountedSlots.add(claim.append)
              scheduleUpdates()
              return claim.render(props)
            },
          })
        },
      },
    }
    const dispose = await plugin.setup(fixtureContext)
    const session = await context.client.session.create({
      title: "Music player smoke",
    })
    await context.data.session.sync(session.id)
    context.ui.router.navigate({ type: "session", sessionID: session.id })
    return async () => {
      for (const timer of updateTimers) clearTimeout(timer)
      await dispose?.()
    }
  },
}
`
  await writeFile(packageEntry, fixtureSource)

  // Keep the existing deterministic media boundary while testing npm resolution.
  const registryRoot = join(root, "registry")
  await mkdir(registryRoot)
  await cp(packageDir, join(registryRoot, "package"), {
    recursive: true,
    dereference: true,
  })
  const fixtureArchive = join(root, "music-loader-fixture.tgz")
  const fixturePack = Bun.spawnSync(
    ["tar", "-czf", fixtureArchive, "-C", registryRoot, "package"],
    { timeout: 30_000 },
  )
  if (!fixturePack.success)
    throw new Error(`Fixture packing failed: ${fixturePack.stderr}`)
  registry = await packedRegistry([fixtureArchive, coreArchive])

  const config = join(root, "xdg", "config", "opencode")
  await mkdir(config, { recursive: true })
  await writeFile(
    join(config, "cli.json"),
    JSON.stringify({ plugins: ["@naxodev/opencode-music-player"] }),
  )
  const graphicsTrace = join(root, "native-graphics.bin")
  const finalSnapshotMarker = join(root, "final-snapshot")
  const pauseTrigger = join(root, "pause-trigger")
  const resumeTrigger = join(root, "resume-trigger")
  await writeFile(graphicsTrace, "")
  const env = {
    ...process.env,
    HOME: root,
    npm_config_registry: registry.url,
    XDG_CONFIG_HOME: join(root, "xdg", "config"),
    XDG_STATE_HOME: join(root, "xdg", "state"),
    XDG_DATA_HOME: join(root, "xdg", "data"),
    XDG_CACHE_HOME: join(root, "xdg", "cache"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_MUSIC_GRAPHICS_TRACE: graphicsTrace,
    OPENCODE_MUSIC_FINAL_SNAPSHOT: finalSnapshotMarker,
    OPENCODE_MUSIC_PAUSE_TRIGGER: pauseTrigger,
    OPENCODE_MUSIC_RESUME_TRIGGER: resumeTrigger,
  }
  const openCodeCommand = [
    openCodeBinary,
    "--standalone",
    "--log-level",
    "debug",
    root,
  ]
    .map(shellQuote)
    .join(" ")
  const command = `exec ${openCodeCommand}`
  const launchTui = () => {
    const launched = Bun.spawnSync(
      [
        "tmux",
        "-L",
        socket,
        "new-session",
        "-d",
        "-s",
        session,
        "-c",
        root,
        "-x",
        "240",
        "-y",
        "40",
        command,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    )
    if (!launched.success)
      throw new Error(
        `tmux new-session failed: ${stripAnsi(launched.stderr.toString())}`,
      )
  }
  const waitForPane = async (
    description: string,
    predicate: (pane: string) => boolean,
    attempts = 100,
  ) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const pane = capturePane()
      if (predicate(pane)) return pane
      if (/\b\d+ plugins? failed\b/.test(pane)) {
        tmux("send-keys", "-t", session, "-l", "/plugins")
        tmux("send-keys", "-t", session, "Enter")
        await Bun.sleep(500)
        tmux("send-keys", "-t", session, "Enter")
        await Bun.sleep(500)
        throw new Error(
          `OpenCode reported a plugin failure while waiting for ${description}`,
        )
      }
      await Bun.sleep(200)
    }
    throw new Error(`timed out waiting for ${description}`)
  }
  const waitForPlayer = () =>
    waitForPane(
      "music player startup",
      (pane) => {
        const compact = pane.replaceAll(/\s/g, "")
        return (
          compact.includes("SMOKECOMPACTTRACKMARKER") &&
          compact.includes("SMOKECOMPACTARTISTMARKER") &&
          pane.includes("Build ·") &&
          pane.includes("shift+tab agents") &&
          !pane.includes("Finishing startup")
        )
      },
      900,
    )
  const waitForFile = async (description: string, path: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await Bun.file(path).exists()) return
      await Bun.sleep(100)
    }
    throw new Error(`timed out waiting for ${description}`)
  }

  try {
    launchTui()
    await waitForPlayer()
    registry.assertInstalled("@naxodev/opencode-music-player")
    registry.assertInstalled("@naxodev/music-core")
    console.log(
      "OpenCode installed both packed music packages by name from an empty host cache.",
    )
    if (!tmux("has-session", "-t", session).success)
      throw new Error("OpenCode exited after rendering plugin UI")
    await waitForPane("settled expanded player", (pane) =>
      Boolean(
        pane.includes("Smoke album") &&
        !pane.includes("Loading artwork") &&
        occurrences(pane, "SMOKE COMPACT TRACK MARKER") === 2 &&
        occurrences(pane, "⏸") >= 2 &&
        pane.includes("Build ·") &&
        pane.includes("shift+tab agents"),
      ),
    )
    await waitForFile("final playback snapshot", finalSnapshotMarker)
    const finalSnapshotPane = capturePane()
    const firstProgress = finalSnapshotPane.match(/\b2:\d{2}\b/)?.[0]
    if (!firstProgress) throw new Error("expanded player omitted progress")
    const advanced = await waitForPane("progress between snapshots", (pane) => {
      const progress = pane.match(/\b2:\d{2}\b/)?.[0]
      return Boolean(
        progress &&
        progress !== firstProgress &&
        !pane.includes("Loading artwork") &&
        occurrences(pane, "SMOKE COMPACT TRACK MARKER") === 2,
      )
    })
    const waveform = (pane: string) =>
      (() => {
        const lines = pane.split("\n")
        const progressIndex = lines.findIndex((line) =>
          /[━─]+●[━─]+/.test(line.slice(-40)),
        )
        return progressIndex >= 2
          ? lines[progressIndex - 2]!.slice(-40)
          : undefined
      })()
    const firstWaveform = waveform(advanced)
    if (!firstWaveform) throw new Error("expanded player omitted waveform")
    await waitForPane(
      "waveform animation between snapshots",
      (pane) => {
        const next = waveform(pane)
        return Boolean(next && next !== firstWaveform)
      },
      10,
    )
    await writeFile(pauseTrigger, "")
    const pausedInPlace = await waitForPane(
      "in-place playback pause",
      (pane) => /\b2:10\s+4:05\b/.test(pane) && occurrences(pane, "▶") >= 2,
    )
    let previousPausedWaveform = waveform(pausedInPlace)
    let stablePausedFrames = 0
    const settledPause = await waitForPane(
      "settled paused waveform",
      (pane) => {
        const current = waveform(pane)
        if (current === undefined) return false
        if (current === previousPausedWaveform) stablePausedFrames++
        else stablePausedFrames = 0
        previousPausedWaveform = current
        return stablePausedFrames >= 4
      },
    )
    const pausedWaveform = waveform(settledPause)
    await writeFile(resumeTrigger, "")
    await waitForPane("in-place playback resume", (pane) => {
      const nextWaveform = waveform(pane)
      return Boolean(
        /\b2:11\s+4:05\b/.test(pane) &&
        occurrences(pane, "⏸") >= 2 &&
        nextWaveform &&
        nextWaveform !== pausedWaveform,
      )
    })
    const graphics = Buffer.from(
      await Bun.file(graphicsTrace).arrayBuffer(),
    ).toString("latin1")
    const transmissions = occurrences(graphics, "a=T")
    const imageDeletes = occurrences(graphics, "a=d,d=I")
    await Bun.sleep(1_000)
    const settledGraphics = Buffer.from(
      await Bun.file(graphicsTrace).arrayBuffer(),
    ).toString("latin1")
    if (transmissions !== 1)
      throw new Error(`native artwork transmitted ${transmissions} times`)
    if (imageDeletes !== 2)
      throw new Error(`native artwork image was deleted ${imageDeletes} times`)
    if (
      occurrences(settledGraphics, "a=T") !== transmissions ||
      occurrences(settledGraphics, "a=d,d=I") !== imageDeletes
    )
      throw new Error("native artwork changed after presentation settled")

    await terminateTmux()
    await writeFile(
      join(config, "cli.json"),
      JSON.stringify({ plugins: [join(packageDir, "dist")] }),
    )
    await writeFile(
      packageEntry,
      fixtureSource.replace("let playing = true", "let playing = false"),
    )
    launchTui()
    await waitForPlayer()
    await waitForPane(
      "settled paused player",
      (pane) =>
        occurrences(pane, "▶") >= 2 &&
        occurrences(pane, "SMOKE COMPACT TRACK MARKER") === 2 &&
        /\b2:05\s+4:05\b/.test(pane) &&
        !pane.includes("Loading artwork"),
    )

    tmux("send-keys", "-t", session, "C-x")
    await Bun.sleep(100)
    tmux("send-keys", "-t", session, "b")
    await waitForPane(
      "collapsed sidebar",
      (pane) =>
        !pane.includes("Smoke album") &&
        pane.includes("SMOKE COMPACT TRACK MARKER") &&
        occurrences(pane, "▶") === 1,
    )

    tmux("resize-window", "-t", session, "-x", "24", "-y", "40")
    await waitForPane(
      "narrow compact layout",
      (pane) =>
        !pane.includes("SMOKE COMPACT ARTIST MARKER") &&
        pane.includes("▶") &&
        pane.includes("SMOKE") &&
        !pane.includes("SMOKE COMPACT TRACK MARKER") &&
        occurrences(pane, "▶") === 1,
    )

    tmux("resize-window", "-t", session, "-x", "5", "-y", "40")
    await waitForPane(
      "smallest compact layout",
      (pane) =>
        pane.includes("▶") &&
        !pane.includes("SMOKE") &&
        occurrences(pane, "▶") === 1,
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const log = await readFile(
      join(root, "xdg", "data", "opencode", "log", "opencode.log"),
      "utf8",
    ).catch(() => "(host log unavailable)")
    throw new Error(
      `OpenCode package smoke failed: ${detail}\n\nSanitized pane:\n${capturePane() || "(empty)"}\nHost log:\n${log.slice(-24000)}`,
    )
  }

  summary = { binary: openCodeBinary, pluginEntry, coreEntry }
} catch (error) {
  workFailure = error
} finally {
  registry?.stop()
  try {
    await terminateTmux()
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    cleanupFailure = error
    console.error(`retained smoke root after cleanup failure: ${root}`)
  }
}

if (workFailure && cleanupFailure)
  throw new Error(
    `${workFailure instanceof Error ? workFailure.message : String(workFailure)}\nCleanup failure: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`,
    { cause: workFailure },
  )
if (workFailure) throw workFailure
if (cleanupFailure) throw cleanupFailure
if (!summary) throw new Error("package smoke completed without a summary")
console.log(`installed OpenCode ${openCodePin}: ${summary.binary}`)
console.log(
  `isolated packed resolutions: plugin=${summary.pluginEntry}; core=${summary.coreEntry}`,
)
console.log(
  "OpenCode loaded the installed package and rendered its app and sidebar slots.",
)
console.log("OpenCode package smoke cleanup: ok")
