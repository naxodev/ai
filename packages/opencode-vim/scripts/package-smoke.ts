import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const manifest = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as { dependencies: { "@opencode-ai/plugin": string } }
const openCodePin = manifest.dependencies["@opencode-ai/plugin"]
const expectedOpenCode = `opencode2 v${openCodePin}`

const socket = `opencode-vim-smoke-${process.pid}-${crypto.randomUUID()}`
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
const waitForPane = async (
  matches: (pane: string) => boolean,
  description: string,
) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    const pane = capturePane()
    if (matches(pane)) return
    await Bun.sleep(250)
  }
  throw new Error(`timed out waiting for ${description}`)
}
const waitForFooter = (label: string) =>
  waitForPane(
    (pane) => pane.replaceAll(/\s/g, "").includes(`--${label}--`),
    `-- ${label} --`,
  )
const runTmux = (...args: string[]) => {
  const result = tmux(...args)
  if (!result.success)
    throw new Error(
      `tmux ${args[0]} failed: ${stripAnsi(result.stderr.toString())}`,
    )
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const packed = Bun.spawnSync(["npm", "pack", "--silent"], {
  stdout: "pipe",
  stderr: "pipe",
})
if (!packed.success) throw new Error(`npm pack failed: ${packed.stderr}`)

const archiveName = packed.stdout.toString().trim().split("\n").at(-1)
if (!archiveName) throw new Error("npm pack did not produce an archive")

const archive = resolve(archiveName)
const work = await mkdtemp(join(tmpdir(), "opencode-vim-smoke-"))

try {
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "@naxodev/opencode-vim": `file:${archive}`,
        "@opencode-ai/cli": openCodePin,
      },
      trustedDependencies: ["@opencode-ai/cli"],
    }),
  )

  const install = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!install.success)
    throw new Error(`package install failed: ${install.stderr}`)

  const openCodeBinary = await realpath(
    join(work, "node_modules", ".bin", "opencode2"),
  )
  const openCodeVersion = Bun.spawnSync([openCodeBinary, "--version"], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (
    !openCodeVersion.success ||
    openCodeVersion.stdout.toString().trim() !== expectedOpenCode
  )
    throw new Error(
      `temporary OpenCode install must provide ${expectedOpenCode}`,
    )

  await writeFile(
    join(work, "smoke.ts"),
    'import plugin from "@naxodev/opencode-vim/tui"\nif (plugin.id !== "vimcode-v2" || typeof plugin.setup !== "function") process.exit(1)\n',
  )
  const loaded = Bun.spawnSync(["bun", "run", "smoke.ts"], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!loaded.success)
    throw new Error(`package import failed: ${loaded.stderr}`)

  const tuiEntry = join(
    work,
    "node_modules",
    "@naxodev",
    "opencode-vim",
    "tui.tsx",
  )
  const reloadMarker = join(work, "reload.log")
  await writeFile(
    tuiEntry,
    `import { appendFileSync } from "node:fs"
const marker = process.env.OPENCODE_VIM_SMOKE_MARKER
if (marker) appendFileSync(marker, "loaded\\n")
export { default } from "./index.tsx"
`,
  )
  const waitForLoads = async (count: number) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const loaded = await readFile(reloadMarker, "utf8").catch(() => "")
      if (loaded.split("\n").filter(Boolean).length >= count) return
      await Bun.sleep(250)
    }
    throw new Error(`timed out waiting for plugin load ${count}`)
  }

  const config = join(work, "config")
  await mkdir(config)
  await writeFile(
    join(config, "cli.json"),
    JSON.stringify({
      plugins: [
        join(work, "node_modules", "@naxodev", "opencode-vim", "tui.tsx"),
      ],
    }),
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
    OPENCODE_VIM_SMOKE_MARKER: reloadMarker,
  }
  const command = [openCodeBinary, "--standalone", "--log-level", "error", work]
    .map(shellQuote)
    .join(" ")
  let stage = "launching OpenCode"
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

    stage = "waiting for INSERT"
    await waitForFooter("INSERT")
    await waitForLoads(1)
    stage = "entering abc"
    runTmux("send-keys", "-t", session, "-l", "abc")
    stage = "leaving insert mode"
    runTmux("send-keys", "-t", session, "Escape")
    stage = "waiting for NORMAL"
    await waitForFooter("NORMAL")
    stage = "setting the unnamed register"
    runTmux("send-keys", "-t", session, "-l", "0")
    runTmux("send-keys", "-t", session, "-l", "y")
    await Bun.sleep(100)
    runTmux("send-keys", "-t", session, "-l", "l")
    stage = "recording undo history"
    runTmux("send-keys", "-t", session, "-l", "x")
    await waitForPane((pane) => pane.includes("bc"), "prompt text bc")
    runTmux("send-keys", "-t", session, "-l", "v")
    await waitForFooter("VISUAL")
    stage = "reloading during visual mode"
    await appendFile(tuiEntry, "\n")
    await waitForLoads(2)
    await waitForFooter("VISUAL")
    stage = "restoring undo history after reload"
    runTmux("send-keys", "-t", session, "Escape")
    await waitForFooter("NORMAL")
    runTmux("send-keys", "-t", session, "-l", "u")
    await waitForPane(
      (pane) => pane.includes("abc"),
      "restored prompt text abc",
    )
    stage = "restoring the unnamed register after reload"
    runTmux("send-keys", "-t", session, "-l", "p")
    await waitForPane(
      (pane) => pane.includes("aabc"),
      "pasted prompt text aabc",
    )
    stage = "changing the visual line"
    runTmux("send-keys", "-t", session, "-l", "V")
    await waitForFooter("VISUAL")
    runTmux("send-keys", "-t", session, "-l", "C")
    stage = "waiting for INSERT after change"
    await waitForFooter("INSERT")
    if (capturePane().includes("aabc"))
      throw new Error("visual C left the original prompt text unchanged")
    stage = "checking literal line-end motion"
    runTmux("send-keys", "-t", session, "-l", "abc")
    runTmux("send-keys", "-t", session, "Escape")
    await waitForFooter("NORMAL")
    runTmux("send-keys", "-t", session, "-l", "0$")
    runTmux("send-keys", "-t", session, "-l", "a")
    await waitForFooter("INSERT")
    runTmux("send-keys", "-t", session, "-l", "X")
    await waitForPane((pane) => pane.includes("abcX"), "prompt text abcX")
    stage = "checking change to line end"
    runTmux("send-keys", "-t", session, "Escape")
    await waitForFooter("NORMAL")
    runTmux("send-keys", "-t", session, "-l", "0c$")
    await waitForFooter("INSERT")
    if (capturePane().includes("abcX"))
      throw new Error("c$ left the original prompt text unchanged")
  } catch (error) {
    const pane = capturePane()
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `OpenCode package smoke failed during ${stage}: ${detail}\n\nSanitized pane:\n${pane || "(empty)"}`,
    )
  } finally {
    tmux("kill-server")
  }

  console.log(
    "OpenCode loaded the installed package and rendered its Vim footer.",
  )
} finally {
  await rm(work, { recursive: true, force: true })
  await rm(archive, { force: true })
}
