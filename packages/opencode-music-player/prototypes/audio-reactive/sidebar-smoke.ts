/** Isolated OpenCode UI check with synthetic helper output; no audio capture. */
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import solidPlugin from "@opentui/solid/bun-plugin"

const work = await mkdtemp(join(tmpdir(), "opencode-audio-sidebar-smoke-"))
const socket = `audio-sidebar-smoke-${process.pid}-${crypto.randomUUID()}`
const session = "preview"
const tmux = (...args: string[]) => {
  const result = Bun.spawnSync(["tmux", "-L", socket, ...args], {
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!result.success)
    throw new Error(`tmux ${args[0]} failed: ${result.stderr}`)
  return result.stdout.toString()
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const capture = () => tmux("capture-pane", "-p", "-t", session)
const waitFor = async (needle: string) => {
  let pane = ""
  for (let attempt = 0; attempt < 100; attempt++) {
    pane = capture()
    if (pane.replaceAll(/\s/g, "").includes(needle.replaceAll(/\s/g, "")))
      return pane
    if (/\b\d+ plugins? failed\b/.test(pane)) {
      tmux("send-keys", "-t", session, "-l", "/plugins")
      tmux("send-keys", "-t", session, "Enter")
      await Bun.sleep(300)
      tmux("send-keys", "-t", session, "Enter")
      await Bun.sleep(300)
      pane = capture()
      const log = Bun.file(join(work, "data/opencode/log/opencode.log"))
      const errors = (await log.exists())
        ? (await log.text())
            .split("\n")
            .filter((line) =>
              /level=ERROR|failed.*plugin|plugin.*failed/.test(line),
            )
            .slice(-8)
            .join("\n")
        : ""
      throw new Error(`${pane}\n${errors}`)
    }
    await Bun.sleep(150)
  }
  throw new Error(`Did not see ${needle}\n${pane}`)
}
const slash = (name: string) => {
  tmux("send-keys", "-t", session, "-l", `/${name}`)
  tmux("send-keys", "-t", session, "Enter")
}

try {
  await mkdir(join(work, "dist"))
  await mkdir(join(work, "bin"))
  const lsof = join(work, "bin/lsof")
  await Bun.write(
    lsof,
    `#!${process.execPath}
if (process.argv[process.argv.indexOf("-p") + 1] !== "56789") process.exit(1)
console.log("p56789\\nftxt\\nn/private/var/folders/fixture/cache/C/com.apple.WebKit.GPU+com.sertacozercan.Kaset/com.apple.WebKit.GPU/com.apple.metal/functions.data")
`,
  )
  await chmod(lsof, 0o700)
  const log = join(work, "capture-lifecycle")
  const sourceObject = join(work, "source-object")
  await Bun.write(sourceObject, "111")
  const helper = join(work, "dist/audio-probe")
  await Bun.write(
    helper,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs"
const object = Number(readFileSync(${JSON.stringify(sourceObject)}, "utf8"))
if (process.argv.includes("--list")) {
  console.log(JSON.stringify({ type: "sources", processes: [
    { pid: 12345, object, name: "cliamp", bundle: "", runningOutput: true },
    { pid: 56788, object: 222, name: "Kaset", bundle: "com.sertacozercan.Kaset", runningOutput: false },
    { pid: 56789, object: object + 1, name: "com.apple.WebKit.GPU", bundle: "com.apple.WebKit.GPU", runningOutput: true },
  ] }))
  process.exit(0)
}
const pid = process.argv[process.argv.indexOf("--pid") + 1]
if (!["12345", "56789"].includes(pid)) throw Error("unexpected source PID")
if (process.argv[process.argv.indexOf("--object") + 1] !== String(pid === "56789" ? object + 1 : object)) throw Error("unexpected source object")
appendFileSync(${JSON.stringify(log)}, "start\\nsource " + pid + "\\n")
const emit = () => console.log(JSON.stringify({ type: "features", bands: [.8,.6,.3,.1], waveform: [[-.5,.5],[-.2,.2]], rms: [.2,.1], peaks: [.4,.2] }))
const timer = setInterval(emit, 50)
const deadline = setTimeout(() => { clearInterval(timer); process.exit(0) }, 30000)
process.on("SIGTERM", () => { appendFileSync(${JSON.stringify(log)}, "stop\\n"); clearInterval(timer); clearTimeout(deadline); process.exit(0) })
console.log(JSON.stringify({ type: "status", state: "starting" }))
emit()
`,
  )
  await chmod(helper, 0o700)
  const outdir = join(work, "built")
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "tui.tsx")],
    outdir,
    target: "bun",
    format: "esm",
    packages: "external",
    plugins: [solidPlugin],
    define: { AUDIO_PROTOTYPE_ROOT: JSON.stringify(work) },
  })
  if (!build.success)
    throw new AggregateError(build.logs, "Fixture build failed")
  const plugin = join(work, "plugin")
  await mkdir(plugin)
  await Bun.write(
    join(plugin, "tui.js"),
    `import plugin from ${JSON.stringify(pathToFileURL(join(outdir, "tui.js")).href)}
export default { ...plugin, async setup(context) {
  const dispose = await plugin.setup(context)
  const session = await context.client.session.create({ title: "Local audio sidebar fixture" })
  await context.data.session.sync(session.id)
  context.ui.router.navigate({ type: "session", sessionID: session.id })
  return dispose
} }
`,
  )
  const config = join(work, "config/opencode")
  await mkdir(config, { recursive: true })
  await Bun.write(
    join(config, "cli.json"),
    JSON.stringify({ plugins: [plugin], session: { sidebar: "auto" } }),
  )
  const executable = Bun.which("opencode")
  if (!executable) throw new Error("OpenCode executable unavailable")
  const result = Bun.spawnSync(
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
      "180",
      "-y",
      "65",
      `exec ${quote(executable)} --standalone ${quote(work)}`,
    ],
    {
      env: {
        ...process.env,
        HOME: work,
        PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: join(work, "config"),
        XDG_DATA_HOME: join(work, "data"),
        XDG_STATE_HOME: join(work, "state"),
        XDG_CACHE_HOME: join(work, "cache"),
        OPENCODE_CONFIG_PROJECT_DISABLE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_CLI_CONFIG_CONTENT: "{}",
      },
      timeout: 10_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (!result.success) throw new Error(result.stderr.toString())
  await waitFor("REAL AUDIO")
  await waitFor("Capture off")
  if (await Bun.file(log).exists())
    throw new Error("Capture started before user action")
  slash("audio-source")
  await waitFor("Local audio source")
  tmux("send-keys", "-t", session, "Down", "Down", "Down", "Enter")
  await waitFor("cliamp · PID 12345")
  slash("audio-start")
  await waitFor("Capture selected process")
  tmux("send-keys", "-t", session, "Enter")
  await waitFor("Capturing cliamp")
  await waitFor("█")
  for (const style of ["mirror", "scope", "meters"]) {
    slash("audio-style")
    await waitFor("Local visualization style")
    tmux("send-keys", "-t", session, "Down", "Enter")
    await waitFor(`${style} ·`)
  }
  await waitFor("dBFS")
  tmux("resize-window", "-t", session, "-x", "180", "-y", "35")
  await waitFor("L███████░░ R██████░░░")
  const starts = (await Bun.file(log).text())
    .split("\n")
    .filter((line) => line === "start").length
  if (starts !== 1) throw new Error(`Style switching started ${starts} helpers`)
  slash("audio-stop")
  await waitFor("Capture off")
  await waitFor("No fresh signal")
  await Bun.write(sourceObject, "112")
  slash("audio-start")
  await waitFor("Selected process identity changed")
  if (
    (await Bun.file(log).text()).split("\n").filter((line) => line === "start")
      .length !== 1
  )
    throw new Error("Stale process selection started capture")
  slash("audio-source")
  await waitFor("Local audio source")
  tmux("send-keys", "-t", session, "Down", "Down", "Enter")
  await waitFor("Kaset (WebKit) · PID 56789")
  if (
    (await Bun.file(log).text()).split("\n").filter((line) => line === "start")
      .length !== 1
  )
    throw new Error("Kaset selection started capture before confirmation")
  slash("audio-start")
  await waitFor("Capture selected process")
  await waitFor("Kaset (WebKit) · PID 56789")
  tmux("send-keys", "-t", session, "Enter")
  await waitFor("Capturing Kaset (WebKit)")
  await waitFor("L███████░░ R██████░░░")
  tmux("resize-window", "-t", session, "-x", "180", "-y", "65")
  await waitFor("dBFS")
  const lifecycle = await Bun.file(log).text()
  if (
    lifecycle.split("\n").filter((line) => line === "start").length !== 2 ||
    !lifecycle.includes("source 56789\n")
  )
    throw new Error("Kaset preview did not capture the attributed helper")
  slash("audio-stop")
  await waitFor("Capture off")
  await waitFor("No fresh signal")
  console.log(
    "Isolated OpenCode sidebar: off by default, explicit source/start, four styles, compact stereo resize, one helper across switches, Stop, stale-identity rejection, and Kaset-attributed helper selection verified with fixtures. No audio captured.",
  )
} finally {
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], {
    timeout: 10_000,
    stdout: "ignore",
    stderr: "ignore",
  })
  await rm(work, { recursive: true, force: true })
}
