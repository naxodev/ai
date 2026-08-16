import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const manifest = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as { dependencies: { "@opencode-ai/plugin": string } }
const expectedOpenCode = `opencode2 v${manifest.dependencies["@opencode-ai/plugin"]}`
const openCodeVersion = Bun.spawnSync(["opencode2", "--version"], {
  stdout: "pipe",
  stderr: "pipe",
})
if (
  !openCodeVersion.success ||
  openCodeVersion.stdout.toString().trim() !== expectedOpenCode
)
  throw new Error(`package smoke requires ${expectedOpenCode}`)

const socket = `opencode-music-player-smoke-${process.pid}-${crypto.randomUUID()}`
const session = "smoke"
const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", "-L", socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
const stripAnsi = (value: string) =>
  value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replaceAll("\r", "")
const capturePane = () => {
  const captured = tmux("capture-pane", "-p", "-e", "-t", session)
  return stripAnsi(captured.stdout.toString())
}
const occurrences = (value: string, marker: string) =>
  value.split(marker).length - 1
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const packed = Bun.spawnSync(["npm", "pack", "--silent"], {
  cwd: process.cwd(),
  stdout: "pipe",
  stderr: "pipe",
})
if (!packed.success) throw new Error(`npm pack failed: ${packed.stderr}`)

const archiveName = packed.stdout.toString().trim().split("\n").at(-1)
if (!archiveName) throw new Error("npm pack did not produce an archive")

const archive = resolve(archiveName)
const work = await mkdtemp(join(tmpdir(), "opencode-music-player-smoke-"))

try {
  const coreDir = fileURLToPath(new URL("../../music-core/", import.meta.url))
  const packedCore = Bun.spawnSync(
    ["npm", "pack", "--silent", "--pack-destination", work],
    {
      cwd: coreDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (!packedCore.success)
    throw new Error(`music-core pack failed: ${packedCore.stderr.toString()}`)
  const coreArchiveName = packedCore.stdout.toString().trim().split("\n").at(-1)
  if (!coreArchiveName)
    throw new Error("music-core pack did not produce an archive")
  const installedCoreArchive = join(work, coreArchiveName)

  await writeFile(
    join(work, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "@naxodev/music-core": `file:${installedCoreArchive}`,
        "@naxodev/opencode-music-player": `file:${archive}`,
      },
      overrides: {
        "@naxodev/music-core": `file:${installedCoreArchive}`,
      },
    }),
  )

  const install = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!install.success)
    throw new Error(`package install failed: ${install.stderr}`)

  const loaded = Bun.spawnSync(
    [
      "bun",
      "-e",
      'import plugin from "@naxodev/opencode-music-player"; if (plugin.id !== "music-player" || typeof plugin.setup !== "function") process.exit(1)',
    ],
    { cwd: work, stdout: "pipe", stderr: "pipe" },
  )
  if (!loaded.success)
    throw new Error(`package import failed: ${loaded.stderr}`)

  const packageDir = join(
    work,
    "node_modules",
    "@naxodev",
    "opencode-music-player",
  )
  const tuiEntry = join(packageDir, "index.tsx")
  const originalEntry = join(packageDir, "index.original.tsx")
  await rename(tuiEntry, originalEntry)
  const fixtureSource = `import { createController, createMusicPlayerPlugin } from "./index.original.tsx"

const track = {
  id: "smoke-track",
  name: "SMOKE COMPACT TRACK MARKER",
  artists: "SMOKE COMPACT ARTIST MARKER",
  album: "Smoke album",
  duration_ms: 245000,
  artwork: null,
}
let playing = true

const plugin = createMusicPlayerPlugin({
  createController: (context) => {
    return createController(context, {
      createSessionMedia: () => ({
        player: async () => ({
          track,
          is_playing: playing,
          progress_ms: 123000,
          fetched_at: Date.now(),
        }),
        play: async () => { playing = true },
        pause: async () => { playing = false },
        next: async () => {},
        previous: async () => {},
        seek: async () => {},
        subscribe: () => () => {},
        subscribePresentation: () => () => {},
        dispose: async () => {},
      }),
    })
  },
})

export default {
  ...plugin,
  async setup(context) {
    const dispose = await plugin.setup(context)
    const session = await context.client.session.create({
      title: "Music player smoke",
    })
    await context.data.session.sync(session.id)
    context.ui.router.navigate({ type: "session", sessionID: session.id })
    return dispose
  },
}
`
  await writeFile(tuiEntry, fixtureSource)

  const config = join(work, "config")
  await mkdir(config)
  await writeFile(
    join(config, "cli.json"),
    JSON.stringify({ plugins: [tuiEntry] }),
  )

  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(work, "xdg", "config"),
    XDG_STATE_HOME: join(work, "xdg", "state"),
    XDG_DATA_HOME: join(work, "xdg", "data"),
    XDG_CACHE_HOME: join(work, "xdg", "cache"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  }
  const command = ["opencode2", "--standalone", "--log-level", "error", work]
    .map(shellQuote)
    .join(" ")
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
        work,
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
  const waitForPlayer = async () => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const compact = capturePane().replaceAll(/\s/g, "")
      if (
        compact.includes("SMOKECOMPACTTRACKMARKER") &&
        compact.includes("SMOKECOMPACTARTISTMARKER")
      )
        return
      if (attempt === 79) throw new Error("timed out waiting for music player")
      await Bun.sleep(250)
    }
  }

  try {
    launchTui()
    await waitForPlayer()
    await Bun.sleep(500)
    if (!tmux("has-session", "-t", session).success)
      throw new Error("OpenCode exited after rendering plugin UI")
    const expanded = capturePane()
    if (!expanded.includes("Smoke album"))
      throw new Error("expanded sidebar did not render its track metadata")
    if (occurrences(expanded, "SMOKE COMPACT TRACK MARKER") !== 2)
      throw new Error("expanded host did not render track in both real slots")
    if (occurrences(expanded, "⏸") < 2)
      throw new Error(
        "expanded sidebar and compact bar disagreed on playing state",
      )
    if (!expanded.includes("Build ·") || !expanded.includes("shift+tab agents"))
      throw new Error("compact row replaced adjacent OpenCode content")

    tmux("kill-server")
    await writeFile(
      tuiEntry,
      fixtureSource.replace("let playing = true", "let playing = false"),
    )
    launchTui()
    await waitForPlayer()
    await Bun.sleep(500)
    const paused = capturePane()
    if (
      occurrences(paused, "▶") < 2 ||
      occurrences(paused, "SMOKE COMPACT TRACK MARKER") !== 2
    )
      throw new Error(
        "expanded sidebar and compact bar disagreed on paused state",
      )

    tmux("send-keys", "-t", session, "C-x")
    await Bun.sleep(100)
    tmux("send-keys", "-t", session, "b")
    await Bun.sleep(300)
    const collapsed = capturePane()
    if (collapsed.includes("Smoke album"))
      throw new Error("sidebar remained visible after session.sidebar.toggle")
    if (!collapsed.includes("SMOKE COMPACT TRACK MARKER"))
      throw new Error("compact app row disappeared after sidebar collapse")
    if (occurrences(collapsed, "▶") !== 1)
      throw new Error("collapsed wide layout duplicated or lost its paused row")

    tmux("resize-window", "-t", session, "-x", "24", "-y", "40")
    await Bun.sleep(300)
    const narrow = capturePane()
    if (narrow.includes("SMOKE COMPACT ARTIST MARKER"))
      throw new Error("compact artist did not yield at narrow width")
    if (!narrow.includes("▶") || !narrow.includes("SMOKE"))
      throw new Error("narrow compact row lost its marker or title")
    if (narrow.includes("SMOKE COMPACT TRACK MARKER"))
      throw new Error("narrow compact title did not truncate")
    if (occurrences(narrow, "▶") !== 1)
      throw new Error("narrow compact layout duplicated its row")

    tmux("resize-window", "-t", session, "-x", "5", "-y", "40")
    await Bun.sleep(300)
    const smallest = capturePane()
    if (!smallest.includes("▶") || smallest.includes("SMOKE"))
      throw new Error("smallest compact layout did not reduce to its marker")
    if (occurrences(smallest, "▶") !== 1)
      throw new Error("smallest compact layout duplicated its row")
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `OpenCode package smoke failed: ${detail}\n\nSanitized pane:\n${capturePane() || "(empty)"}`,
    )
  } finally {
    tmux("kill-server")
  }

  console.log(
    "OpenCode loaded the installed package and rendered its app and sidebar slots.",
  )
} finally {
  await rm(work, { recursive: true, force: true })
  await rm(archive, { force: true })
}
