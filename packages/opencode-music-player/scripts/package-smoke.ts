import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

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
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { "@naxodev/opencode-music-player": `file:${archive}` },
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
  await writeFile(
    tuiEntry,
    `import plugin from "./index.original.tsx"

export default {
  ...plugin,
  setup(context: Parameters<typeof plugin.setup>[0]) {
    let sidebar: ((props: { sessionID: string }) => unknown) | undefined
    const wrappedContext = {
      ...context,
      ui: {
        ...context.ui,
        slot(name: string, render: (props: any) => unknown) {
          if (name === "sidebar.content") sidebar = render
          return context.ui.slot(name as any, render as any)
        },
      },
    } as typeof context
    const dispose = plugin.setup(wrappedContext)
    if (!sidebar) throw new Error("music plugin did not register its sidebar")
    const unsubscribe = context.ui.slot("prompt.footer.end", () =>
      sidebar!({ sessionID: "smoke" }) as any,
    )
    return () => {
      unsubscribe()
      dispose()
    }
  },
}
`,
  )

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

  try {
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

    for (let attempt = 0; attempt < 80; attempt++) {
      if (capturePane().replaceAll(/\s/g, "").includes("Nowplaying")) break
      if (attempt === 79) throw new Error("timed out waiting for music sidebar")
      await Bun.sleep(250)
    }
    await Bun.sleep(500)
    if (!tmux("has-session", "-t", session).success)
      throw new Error("OpenCode exited after rendering plugin UI")
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `OpenCode package smoke failed: ${detail}\n\nSanitized pane:\n${capturePane() || "(empty)"}`,
    )
  } finally {
    tmux("kill-server")
  }

  console.log("OpenCode loaded the installed package and rendered its sidebar.")
} finally {
  await rm(work, { recursive: true, force: true })
  await rm(archive, { force: true })
}
