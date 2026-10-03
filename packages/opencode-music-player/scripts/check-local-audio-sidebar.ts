/** Isolated real-TUI check with a real daemon and synthetic subprocess features. */
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import solidPlugin from "@opentui/solid/bun-plugin"
import { startLocalAudioFixture } from "../../music-core/tests/local-audio-fixture.ts"

const executable = Bun.which("opencode")
if (!executable || !Bun.which("tmux"))
  throw new Error("The local UI fixture requires installed OpenCode and tmux")
const work = await mkdtemp(join(tmpdir(), "music-local-daemon-ui-"))
const socketPath = `/tmp/music-local-ui-${process.pid}-${crypto.randomUUID()}.sock`
const tmuxSocket = `music-local-ui-${process.pid}-${crypto.randomUUID()}`
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const tmux = (...args: string[]) => {
  const result = Bun.spawnSync(["tmux", "-L", tmuxSocket, ...args], {
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!result.success)
    throw new Error(`tmux ${args[0]} failed: ${result.stderr}`)
  return result.stdout.toString()
}
const pane = () => tmux("capture-pane", "-p", "-t", "preview")
const waitFor = async (predicate: string | RegExp) => {
  let text = ""
  for (let attempt = 0; attempt < 100; attempt++) {
    text = pane()
    if (
      typeof predicate === "string"
        ? text.includes(predicate)
        : predicate.test(text)
    )
      return text
    if (/\b\d+ plugins? failed\b/.test(text))
      throw new Error(`Plugin reconciliation failed\n${text}`)
    await Bun.sleep(100)
  }
  throw new Error(`UI did not show ${predicate}\n${text}`)
}
const slash = (name: string) => {
  tmux("send-keys", "-t", "preview", "-l", `/${name}`)
  tmux("send-keys", "-t", "preview", "Enter")
}
let fixture: Awaited<ReturnType<typeof startLocalAudioFixture>> | undefined
try {
  fixture = await startLocalAudioFixture(socketPath)
  const built = join(work, "built")
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../local-audio/tui.ts")],
    outdir: built,
    target: "bun",
    format: "esm",
    packages: "external",
    plugins: [solidPlugin],
    define: { LOCAL_MUSIC_AUDIO_SOCKET: JSON.stringify(socketPath) },
  })
  if (!build.success)
    throw new AggregateError(build.logs, "Local UI fixture build failed")
  // Resolve workspace core from the clone. Host UI libraries remain external.
  await symlink(
    resolve(import.meta.dir, "../node_modules"),
    join(built, "node_modules"),
    "dir",
  )
  const plugin = join(work, "plugin")
  await mkdir(plugin)
  await Bun.write(
    join(plugin, "tui.js"),
    `import plugin from ${JSON.stringify(pathToFileURL(join(built, "tui.js")).href)}
export default { ...plugin, async setup(context) {
  const dispose = await plugin.setup(context)
  const session = await context.client.session.create({ title: "Synthetic daemon audio fixture" })
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
  const command = `exec ${quote(executable)} --standalone ${quote(work)}`
  const started = Bun.spawnSync(
    [
      "tmux",
      "-L",
      tmuxSocket,
      "new-session",
      "-d",
      "-s",
      "preview",
      "-c",
      work,
      "-x",
      "180",
      "-y",
      "65",
      command,
    ],
    {
      env: {
        ...process.env,
        HOME: work,
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
  if (!started.success) throw new Error(started.stderr.toString())
  await waitFor("REAL AUDIO")
  await waitFor("Capture off")
  if (fixture.starts() !== 0)
    throw new Error("UI started capture without approval")
  slash("live-audio-source")
  await waitFor("Local daemon source")
  tmux("send-keys", "-t", "preview", "Enter")
  await waitFor("Kaset (WebKit)")
  slash("live-audio-start")
  await waitFor("Capture selected process")
  tmux("send-keys", "-t", "preview", "Enter")
  await waitFor("Capturing selected")
  await waitFor("█")
  for (const style of ["mirror", "scope", "meters"]) {
    slash("live-audio-style")
    await waitFor("Local daemon visualization style")
    tmux("send-keys", "-t", "preview", "Down", "Enter")
    await waitFor(style)
  }
  await waitFor("dBFS")
  tmux("resize-window", "-t", "preview", "-x", "180", "-y", "35")
  await waitFor(/L[█░│]+\s+R[█░│]+/)
  if (fixture.starts() !== 1)
    throw new Error("Style or resize restarted the helper")
  slash("live-audio-stop")
  await waitFor("Capture off")
  await waitFor("No fresh signal")
  await fixture.waitCapturesClosed()
  slash("live-audio-source")
  await waitFor("Local daemon source")
  tmux("send-keys", "-t", "preview", "Enter")
  await waitFor("Kaset (WebKit)")
  fixture.setLaunch("101:0")
  slash("live-audio-start")
  await waitFor("Capture selected process")
  tmux("send-keys", "-t", "preview", "Enter")
  await waitFor("Capture not started")
  if (fixture.starts() !== 1)
    throw new Error("Stale approval captured a replacement")
  tmux("respawn-pane", "-k", "-t", "preview", command)
  await waitFor("REAL AUDIO")
  await waitFor("Capture off")
  await waitFor("meters")
  await waitFor("Not selected")
  if (fixture.starts() !== 1) throw new Error("Reload replayed Start")
  console.log(
    "Local daemon sidebar verified: off by default, selection/confirmation, four styles, compact stereo, one helper, Stop, stale identity, and style-only persistence after reload. Synthetic features only; no audio captured or played.",
  )
} finally {
  Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"], {
    timeout: 10_000,
    stdout: "ignore",
    stderr: "ignore",
  })
  await fixture?.close()
  await rm(work, { recursive: true, force: true })
}
