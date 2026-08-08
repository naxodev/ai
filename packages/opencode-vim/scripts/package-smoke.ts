import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

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
      dependencies: { "@naxodev/opencode-vim": `file:${archive}` },
    }),
  )

  const install = Bun.spawnSync(["bun", "install", "--silent"], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!install.success)
    throw new Error(`package install failed: ${install.stderr}`)

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

  const config = join(work, "config")
  const transcript = join(work, "tui.log")
  await mkdir(config)
  await writeFile(
    join(config, "cli.json"),
    JSON.stringify({
      plugins: [
        join(work, "node_modules", "@naxodev", "opencode-vim", "tui.tsx"),
      ],
    }),
  )

  const tui = Bun.spawn(
    [
      "script",
      "-q",
      transcript,
      "opencode2",
      "--standalone",
      "--log-level",
      "error",
      work,
    ],
    {
      cwd: work,
      env: {
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
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  )

  let footerLoaded = false
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      const output = await readFile(transcript, "utf8").catch(() => "")
      if (output.includes("-- INSERT -")) {
        footerLoaded = true
        break
      }
      await Bun.sleep(250)
    }
  } finally {
    tui.kill()
  }

  if (!footerLoaded) {
    const stderr = await new Response(tui.stderr).text()
    const output = await readFile(transcript, "utf8").catch(() => "")
    throw new Error(
      `OpenCode TUI did not load the Vim footer: ${stderr}${output}`,
    )
  }

  console.log(
    "OpenCode loaded the installed package and rendered its Vim footer.",
  )
} finally {
  await rm(work, { recursive: true, force: true })
  await rm(archive, { force: true })
}
