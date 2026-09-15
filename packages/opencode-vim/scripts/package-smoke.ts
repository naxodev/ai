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
import { dirname, join, resolve } from "node:path"
import {
  checkOpenCodeCompatibility,
  compatibility,
  hostDependencies,
} from "../../../scripts/opencode-compatibility.ts"
import { packedRegistry } from "../../../scripts/packed-registry.ts"

await checkOpenCodeCompatibility()
const openCodePin = compatibility.host.version
const expectedOpenCode = `${compatibility.host.binary} v${openCodePin}`

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
  attempts = 80,
) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pane = capturePane()
    if (matches(pane)) return
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
        [compatibility.host.package]: openCodePin,
      },
    }),
  )

  console.log(`Installing packed Vim plugin and OpenCode ${openCodePin}`)
  const install = Bun.spawnSync(
    ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: work,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (!install.success)
    throw new Error(`package install failed: ${install.stderr}`)

  const cliHook = Bun.spawnSync(
    [
      "node",
      join(work, "node_modules", compatibility.host.package, "postinstall.mjs"),
    ],
    { cwd: work, timeout: 30_000, stdout: "pipe", stderr: "pipe" },
  )
  if (!cliHook.success)
    throw new Error(`CLI installation hook failed: ${cliHook.stderr}`)

  console.log("Checking the isolated OpenCode executable")
  const openCodeBinary = await realpath(
    join(work, "node_modules", ".bin", compatibility.host.binary),
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

  for (const name of Object.keys(hostDependencies)) {
    if (
      await Bun.file(join(work, "node_modules", name, "package.json")).exists()
    )
      throw new Error(
        `Host-provided ${name} must not be installed in the smoke consumer`,
      )
  }

  const registry = await packedRegistry([archive])
  const nameHome = join(work, "package-name")
  const nameConfig = join(nameHome, "config", "opencode")
  await mkdir(nameConfig, { recursive: true })
  await writeFile(
    join(nameConfig, "cli.json"),
    JSON.stringify({
      plugins: [
        {
          package: "@naxodev/opencode-vim",
          options: { startMode: "normal", clipboard: "none" },
        },
      ],
    }),
  )
  try {
    const named = Bun.spawnSync(
      [
        "tmux",
        "-L",
        socket,
        "new-session",
        "-d",
        "-s",
        session,
        "-c",
        nameHome,
        "-x",
        "240",
        "-y",
        "40",
        [openCodeBinary, "--standalone", nameHome].map(shellQuote).join(" "),
      ],
      {
        env: {
          ...process.env,
          HOME: nameHome,
          XDG_CONFIG_HOME: join(nameHome, "config"),
          XDG_CACHE_HOME: join(nameHome, "cache"),
          XDG_DATA_HOME: join(nameHome, "data"),
          XDG_STATE_HOME: join(nameHome, "state"),
          npm_config_registry: registry.url,
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_CONFIG_PROJECT_DISABLE: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        },
        timeout: 10_000,
      },
    )
    if (!named.success)
      throw new Error(`Package-name launch failed: ${named.stderr}`)
    await waitForPane(
      (pane) => pane.replaceAll(/\s/g, "").includes("--NORMAL--"),
      "package-name NORMAL footer",
      720,
    )
    registry.assertInstalled("@naxodev/opencode-vim")
    console.log(
      "OpenCode installed the packed package by name from an empty cache; startMode=normal took effect.",
    )
  } catch (error) {
    const log = await readFile(
      join(nameHome, "data", "opencode", "log", "opencode.log"),
      "utf8",
    ).catch(() => "(host log unavailable)")
    throw new Error(
      `Package-name Vim smoke failed: ${error}\n${capturePane()}\nHost log:\n${log.slice(-24000)}`,
    )
  } finally {
    tmux("kill-server")
    await registry.stop()
  }

  const tuiEntry = join(
    work,
    "node_modules",
    "@naxodev",
    "opencode-vim",
    "dist",
    "tui.js",
  )
  const reloadMarker = join(work, "reload.log")
  await writeFile(
    tuiEntry,
    `import { appendFileSync } from "node:fs"
const marker = process.env.OPENCODE_VIM_SMOKE_MARKER
if (marker) appendFileSync(marker, "loaded\\n")
export { default } from "./index.js"
`,
  )
  const waitForLoads = async (count: number) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const loaded = await readFile(reloadMarker, "utf8").catch(() => "")
      if (
        loaded.split("\n").filter((line) => line === "loaded").length >= count
      )
        return
      await Bun.sleep(250)
    }
    throw new Error(`timed out waiting for plugin load ${count}`)
  }

  const config = join(work, "xdg", "config", "opencode")
  await mkdir(config, { recursive: true })
  await writeFile(
    join(config, "cli.json"),
    JSON.stringify({
      plugins: [
        {
          package: dirname(tuiEntry),
          // Exercise the Vim register without writing to the user's clipboard.
          options: { clipboard: "none" },
        },
      ],
    }),
  )

  const env = {
    ...process.env,
    HOME: work,
    XDG_CONFIG_HOME: join(work, "xdg", "config"),
    XDG_STATE_HOME: join(work, "xdg", "state"),
    XDG_DATA_HOME: join(work, "xdg", "data"),
    XDG_CACHE_HOME: join(work, "xdg", "cache"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_VIM_SMOKE_MARKER: reloadMarker,
  }
  const command = [openCodeBinary, "--standalone", "--log-level", "debug", work]
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
    const log = await readFile(
      join(work, "xdg", "data", "opencode", "log", "opencode.log"),
      "utf8",
    ).catch(() => "(host log unavailable)")
    throw new Error(
      `OpenCode package smoke failed during ${stage}: ${detail}\n\nSanitized pane:\n${pane || "(empty)"}\nHost log:\n${log.slice(-30000)}`,
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
