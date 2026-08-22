/**
 * No-vim pi agent dir for role panes. Pure filter + temp-dir materialize.
 */
import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  filterPackagesNoVim,
  isPiCmd,
  isPiVimModePackage,
  materializePiRoleAgentDir,
  syncDirectoryAfterRename,
  wrapInteractiveCmdNoVim,
  defaultRoleAgentDir,
} from "./pi-role-agent.ts"

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs.length = 0
})

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-pi-role-"))
  tmpDirs.push(d)
  return d
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (e) {
    throw new Error(
      `expected valid JSON at ${file}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

test("defaultRoleAgentDir ignores HOME and USERPROFILE", () => {
  const home = process.env.HOME
  const userProfile = process.env.USERPROFILE
  process.env.HOME = "/tmp/untrusted-pi-home"
  process.env.USERPROFILE = "/tmp/untrusted-pi-profile"
  try {
    expect(defaultRoleAgentDir()).toBe(
      path.join(os.homedir(), ".config", "apnea", "pi-role-agent"),
    )
  } finally {
    if (home === undefined) delete process.env.HOME
    else process.env.HOME = home
    if (userProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = userProfile
  }
})

describe("isPiCmd / isPiVimModePackage", () => {
  // Wrong binary detection would either skip the no-vim wrap (coder stuck
  // in INSERT) or inject env into claude launches for no reason.
  test("detects pi binary by basename", () => {
    expect(isPiCmd(["pi"])).toBe(true)
    expect(isPiCmd(["/usr/local/bin/pi", "--provider", "x"])).toBe(true)
    expect(isPiCmd(["claude", "--model", "x"])).toBe(false)
    expect(isPiCmd([])).toBe(false)
    expect(isPiCmd(null)).toBe(false)
  })

  test("detects supported env and bunx wrappers", () => {
    expect(isPiCmd(["env", "pi", "--provider", "x"])).toBe(true)
    expect(isPiCmd(["bunx", "pi", "--provider", "x"])).toBe(true)
    expect(isPiCmd(["bunx", "other"])).toBe(false)
  })

  test("detects vimmode package forms", () => {
    expect(isPiVimModePackage("npm:pi-vimmode")).toBe(true)
    expect(isPiVimModePackage("npm:pi-lens")).toBe(false)
    expect(
      isPiVimModePackage({ source: "git:github.com/pekochan069/pi-vimmode" }),
    ).toBe(true)
    expect(isPiVimModePackage({ source: "npm:pi-btw" })).toBe(false)
  })
})

describe("filterPackagesNoVim", () => {
  // Role panes must keep every other package; only vimmode is the hazard.
  test("strips vimmode string and object entries, keeps others", () => {
    const input = [
      "npm:pi-lens",
      "npm:pi-vimmode",
      { source: "npm:pi-web-access" },
      { source: "npm:pi-vimmode", extensions: [] },
      "../../work/1-projects/naxodev/pi-apnea",
    ]
    expect(filterPackagesNoVim(input)).toEqual([
      "npm:pi-lens",
      { source: "npm:pi-web-access" },
      "../../work/1-projects/naxodev/pi-apnea",
    ])
  })

  test("non-array → empty", () => {
    expect(filterPackagesNoVim(undefined)).toEqual([])
    expect(filterPackagesNoVim("x")).toEqual([])
  })
})

describe("materializePiRoleAgentDir", () => {
  // Materialize must produce a usable agent dir without pi-vimmode so
  // PI_CODING_AGENT_DIR launches never load modal vim.
  test("writes settings without vimmode and links auth", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({
        packages: ["npm:pi-lens", "npm:pi-vimmode", "npm:pi-btw"],
        extensions: [
          "/opt/pi/extensions/provider.ts",
          "/Users/test/src/pi-vimmode/index.ts",
        ],
        piVimMode: { preset: "vim-heavy" },
        theme: "tokyo-night-moon",
      }),
      "utf8",
    )
    fs.writeFileSync(path.join(source, "auth.json"), '{"ok":true}\n', "utf8")
    fs.mkdirSync(path.join(source, "npm"))
    fs.writeFileSync(path.join(source, "npm", "marker"), "1", "utf8")

    const out = materializePiRoleAgentDir({
      sourceAgentDir: source,
      destDir: dest,
    })
    expect(out).toBe(dest)

    const settings = readJson(path.join(dest, "settings.json")) as {
      packages: unknown[]
      extensions: unknown[]
      piVimMode?: unknown
      theme?: string
    }
    expect(settings.packages).toEqual(["npm:pi-lens", "npm:pi-btw"])
    expect(settings.extensions).toEqual([
      path.resolve("/opt/pi/extensions/provider.ts").split(path.sep).join("/"),
    ])
    expect(settings.piVimMode).toBeUndefined()
    expect(settings.theme).toBe("tokyo-night-moon")

    // auth linked/copied
    expect(fs.existsSync(path.join(dest, "auth.json"))).toBe(true)
    expect(fs.readFileSync(path.join(dest, "auth.json"), "utf8")).toContain(
      "ok",
    )
    expect(fs.existsSync(path.join(dest, "npm", "marker"))).toBe(true)
  })

  test("idempotent refresh drops newly-added vimmode", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-lens"] }),
      "utf8",
    )
    materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest })

    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-lens", "npm:pi-vimmode"] }),
      "utf8",
    )
    materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest })
    const settings = readJson(path.join(dest, "settings.json")) as {
      packages: unknown[]
    }
    expect(settings.packages).toEqual(["npm:pi-lens"])
  })

  test("refuses malformed source settings instead of replacing them with empty settings", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.writeFileSync(path.join(source, "settings.json"), "{broken", "utf8")

    expect(() =>
      materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest }),
    ).toThrow("invalid source Pi settings")
    expect(fs.existsSync(path.join(dest, "settings.json"))).toBe(false)
  })

  test("refuses a malformed packages setting", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({ packages: "npm:pi-vimmode" }),
      "utf8",
    )

    expect(() =>
      materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest }),
    ).toThrow("invalid source Pi settings")
  })

  test("rejects every malformed package entry shape", () => {
    const malformed = [
      null,
      {},
      { source: "" },
      { source: 42 },
      { source: "npm:provider", autoload: "yes" },
      { source: "npm:provider", extensions: "index.ts" },
      { source: "npm:provider", skills: [42] },
      { source: "npm:provider", unknown: true },
    ]

    for (const entry of malformed) {
      const source = tmp()
      const dest = path.join(tmp(), "role-agent")
      fs.writeFileSync(
        path.join(source, "settings.json"),
        JSON.stringify({ packages: [entry] }),
        "utf8",
      )
      expect(() =>
        materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest }),
      ).toThrow("invalid source Pi settings")
    }
  })

  test("rebases safe relative sources and filters canonical vimmode aliases", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    const provider = path.join(source, "local-provider")
    const vimRoot = path.join(tmp(), "pi-vimmode-root")
    fs.mkdirSync(provider)
    fs.writeFileSync(path.join(provider, "index.ts"), "provider\n", "utf8")
    fs.mkdirSync(vimRoot)
    fs.writeFileSync(path.join(vimRoot, "index.ts"), "vimmode\n", "utf8")
    fs.symlinkSync(vimRoot, path.join(source, "vim-alias"))
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({
        packages: [
          "npm:pi-lens",
          "./local-provider",
          "./vim-alias",
          {
            source: "./local-provider",
            autoload: false,
            extensions: ["index.ts"],
            skills: [],
            prompts: [],
            themes: [],
          },
          { source: "./vim-alias" },
        ],
        extensions: ["./local-provider/index.ts", "./vim-alias/index.ts"],
      }),
      "utf8",
    )

    materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest })

    const settings = readJson(path.join(dest, "settings.json")) as {
      packages: Array<string | { source: string }>
      extensions: string[]
    }
    expect(settings.packages[0]).toBe("npm:pi-lens")
    expect(
      fs.realpathSync(path.resolve(dest, settings.packages[1] as string)),
    ).toBe(fs.realpathSync(provider))
    expect(
      fs.realpathSync(
        path.resolve(dest, (settings.packages[2] as { source: string }).source),
      ),
    ).toBe(fs.realpathSync(provider))
    expect(settings.packages).toHaveLength(3)
    expect(settings.extensions).toHaveLength(1)
    expect(fs.realpathSync(path.resolve(dest, settings.extensions[0]!))).toBe(
      fs.realpathSync(path.join(provider, "index.ts")),
    )
  })

  test("preserves exclusion operators while filtering positive vimmode patterns", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    const custom = path.join(source, "custom")
    const provider = path.join(custom, "provider.ts")
    const vimmode = path.join(custom, "pi-vimmode.ts")
    const aliasedVimRoot = path.join(tmp(), "pi-vimmode-alias-root")
    fs.mkdirSync(custom)
    fs.writeFileSync(provider, "provider\n", "utf8")
    fs.writeFileSync(vimmode, "vimmode\n", "utf8")
    fs.mkdirSync(aliasedVimRoot)
    fs.writeFileSync(path.join(aliasedVimRoot, "index.ts"), "vimmode\n", "utf8")
    fs.symlinkSync(aliasedVimRoot, path.join(source, "editor-alias"))
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({
        extensions: [
          "./custom",
          "!./custom/pi-vimmode.ts",
          "-./custom/pi-vimmode.ts",
          "+./custom/pi-vimmode.ts",
          "+./editor-alias/index.ts",
          "+./custom/provider.ts",
          "./custom/provider.ts",
        ],
      }),
      "utf8",
    )

    materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest })

    const settings = readJson(path.join(dest, "settings.json")) as {
      extensions: string[]
    }
    expect(settings.extensions.map((pattern) => pattern[0])).toEqual([
      ".",
      "!",
      "-",
      "+",
      ".",
    ])
    expect(settings.extensions).toHaveLength(5)
    for (const pattern of settings.extensions) {
      const operator = ["!", "+", "-"].includes(pattern[0]!) ? pattern[0]! : ""
      const target = operator ? pattern.slice(1) : pattern
      const canonical = fs.realpathSync(path.resolve(dest, target))
      if (operator === "!" || operator === "-") {
        expect(canonical).toBe(fs.realpathSync(vimmode))
      } else if (canonical !== fs.realpathSync(custom)) {
        expect(canonical).toBe(fs.realpathSync(provider))
      }
    }
    expect(
      settings.extensions.some(
        (pattern) => pattern.startsWith("+") && pattern.includes("pi-vimmode"),
      ),
    ).toBe(false)
  })

  test("maps mirrored extension patterns to destination paths and rebases external paths", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    const sourceExtensions = path.join(source, "extensions")
    const external = path.join(source, "external")
    fs.mkdirSync(sourceExtensions)
    fs.mkdirSync(external)
    fs.writeFileSync(
      path.join(sourceExtensions, "provider.ts"),
      "provider\n",
      "utf8",
    )
    fs.writeFileSync(
      path.join(sourceExtensions, "legacy.ts"),
      "legacy\n",
      "utf8",
    )
    fs.writeFileSync(path.join(external, "provider.ts"), "provider\n", "utf8")
    fs.writeFileSync(path.join(external, "legacy.ts"), "legacy\n", "utf8")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({
        extensions: [
          "-extensions/provider.ts",
          "!extensions/legacy.ts",
          "+extensions/provider.ts",
          "./external/provider.ts",
          "-./external/legacy.ts",
        ],
      }),
      "utf8",
    )

    materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest })

    const settings = readJson(path.join(dest, "settings.json")) as {
      extensions: string[]
    }
    expect(settings.extensions).toEqual([
      "-extensions/provider.ts",
      "!extensions/legacy.ts",
      "+extensions/provider.ts",
      path
        .relative(dest, fs.realpathSync(path.join(external, "provider.ts")))
        .split(path.sep)
        .join("/"),
      `-${path
        .relative(dest, fs.realpathSync(path.join(external, "legacy.ts")))
        .split(path.sep)
        .join("/")}`,
    ])
    expect(fs.existsSync(path.join(dest, "extensions", "provider.ts"))).toBe(
      true,
    )
    expect(fs.existsSync(path.join(dest, "extensions", "legacy.ts"))).toBe(true)
    expect(fs.existsSync(path.resolve(dest, settings.extensions[3]!))).toBe(
      true,
    )
  })

  test("refuses a broken source settings symlink", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.symlinkSync(
      path.join(source, "missing.json"),
      path.join(source, "settings.json"),
    )

    expect(() =>
      materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest }),
    ).toThrow("invalid source Pi settings")
  })

  test("refuses a symlink destination settings file", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    const target = path.join(tmp(), "target.json")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({ packages: [] }),
      "utf8",
    )
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(target, '{"untouched":true}\n', "utf8")
    fs.symlinkSync(target, path.join(dest, "settings.json"))

    expect(() =>
      materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest }),
    ).toThrow("destination Pi settings must not be a symlink")
    expect(fs.readFileSync(target, "utf8")).toBe('{"untouched":true}\n')
  })

  test("preserves provider extensions and excludes vimmode extension roots", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({ packages: [] }),
      "utf8",
    )
    fs.mkdirSync(path.join(source, "extensions"))
    fs.mkdirSync(path.join(source, "extensions", "required-provider"))
    fs.writeFileSync(
      path.join(source, "extensions", "pi-vimmode.ts"),
      "export default () => {}\n",
      "utf8",
    )
    fs.writeFileSync(
      path.join(source, "extensions", "required-provider", "index.ts"),
      "export default () => {}\n",
      "utf8",
    )
    fs.writeFileSync(
      path.join(source, "extensions", "required-provider", "provider.json"),
      '{"required":true}\n',
      "utf8",
    )
    const hiddenVimRoot = path.join(tmp(), "local-pi-vimmode-root")
    fs.mkdirSync(hiddenVimRoot)
    fs.writeFileSync(path.join(hiddenVimRoot, "index.ts"), "", "utf8")
    fs.symlinkSync(
      hiddenVimRoot,
      path.join(source, "extensions", "friendly-name"),
    )
    fs.mkdirSync(path.join(dest, "extensions"), { recursive: true })
    fs.writeFileSync(path.join(dest, "extensions", "stale.ts"), "", "utf8")

    materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest })

    expect(
      fs.readFileSync(
        path.join(dest, "extensions", "required-provider", "provider.json"),
        "utf8",
      ),
    ).toBe('{"required":true}\n')
    expect(fs.existsSync(path.join(dest, "extensions", "pi-vimmode.ts"))).toBe(
      false,
    )
    expect(fs.existsSync(path.join(dest, "extensions", "friendly-name"))).toBe(
      false,
    )
    expect(fs.existsSync(path.join(dest, "extensions", "stale.ts"))).toBe(false)
  })

  test("refuses identical source and destination without mutating source files", () => {
    const agentDir = tmp()
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-vimmode", "npm:pi-lens"] }),
      "utf8",
    )
    fs.writeFileSync(path.join(agentDir, "auth.json"), '{"ok":true}\n', "utf8")

    expect(() =>
      materializePiRoleAgentDir({
        sourceAgentDir: agentDir,
        destDir: agentDir,
      }),
    ).toThrow("source and destination Pi agent directories must differ")

    expect(
      fs.lstatSync(path.join(agentDir, "auth.json")).isSymbolicLink(),
    ).toBe(false)
    expect(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")).toContain(
      "ok",
    )
    const settings = readJson(path.join(agentDir, "settings.json")) as {
      packages: unknown[]
    }
    expect(settings.packages).toEqual(["npm:pi-vimmode", "npm:pi-lens"])
  })

  test("refuses a symlinked destination root without touching its target", () => {
    const source = tmp()
    const outside = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({ packages: [] }),
      "utf8",
    )
    fs.writeFileSync(path.join(outside, "keep.txt"), "outside\n", "utf8")
    fs.symlinkSync(outside, dest)

    expect(() =>
      materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest }),
    ).toThrow("destination Pi agent directory must not be a symlink")
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe(
      "outside\n",
    )
    expect(fs.existsSync(path.join(outside, "settings.json"))).toBe(false)
  })

  test("refuses canonical source aliases without mutating the destination", () => {
    const agentDir = tmp()
    const sourceAlias = path.join(tmp(), "source-agent")
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-vimmode"] }),
      "utf8",
    )
    fs.writeFileSync(path.join(agentDir, "keep.txt"), "keep\n", "utf8")
    fs.symlinkSync(agentDir, sourceAlias)

    expect(() =>
      materializePiRoleAgentDir({
        sourceAgentDir: sourceAlias,
        destDir: agentDir,
      }),
    ).toThrow("source and destination Pi agent directories must differ")
    expect(fs.readFileSync(path.join(agentDir, "keep.txt"), "utf8")).toBe(
      "keep\n",
    )
    expect(readJson(path.join(agentDir, "settings.json"))).toEqual({
      packages: ["npm:pi-vimmode"],
    })
  })

  test("refuses a source symlink that targets the future destination", () => {
    const parent = tmp()
    const dest = path.join(parent, "future-role-agent")
    const sourceAlias = path.join(parent, "source-agent")
    fs.symlinkSync(dest, sourceAlias)

    expect(() =>
      materializePiRoleAgentDir({
        sourceAgentDir: sourceAlias,
        destDir: dest,
      }),
    ).toThrow("source and destination Pi agent directories must differ")
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(path.join(dest, "settings.json"))).toBe(false)
  })

  test("skips destination directory fsync on Windows", () => {
    const calls: string[] = []
    syncDirectoryAfterRename("C:\\role-agent", "win32", {
      openSync: () => {
        calls.push("open")
        return 1
      },
      fsyncSync: () => calls.push("fsync"),
      closeSync: () => calls.push("close"),
    })
    expect(calls).toEqual([])
  })
})

describe("wrapInteractiveCmdNoVim", () => {
  // Non-pi cmds must not be rewritten — only pi needs the agent-dir env.
  test("wraps pi with env PI_CODING_AGENT_DIR; leaves claude alone", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-vimmode", "npm:pi-lens"] }),
      "utf8",
    )

    expect(wrapInteractiveCmdNoVim(["claude", "--model", "x"])).toEqual([
      "claude",
      "--model",
      "x",
    ])

    const wrapped = wrapInteractiveCmdNoVim(["pi", "--provider", "grok-cli"], {
      sourceAgentDir: source,
      destDir: dest,
    })
    expect(wrapped).toEqual([
      "env",
      `PI_CODING_AGENT_DIR=${dest}`,
      "pi",
      "--provider",
      "grok-cli",
    ])
    const settings = readJson(path.join(dest, "settings.json")) as {
      packages: unknown[]
    }
    expect(settings.packages).toEqual(["npm:pi-lens"])
  })

  test("normalizes env and bunx wrappers before adding the isolated directory", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({ packages: [] }),
      "utf8",
    )

    expect(
      wrapInteractiveCmdNoVim(["env", "pi", "--provider", "x"], {
        sourceAgentDir: source,
        destDir: dest,
      }),
    ).toEqual(["env", `PI_CODING_AGENT_DIR=${dest}`, "pi", "--provider", "x"])
    expect(
      wrapInteractiveCmdNoVim(["bunx", "pi", "--provider", "x"], {
        sourceAgentDir: source,
        destDir: dest,
      }),
    ).toEqual([
      "env",
      `PI_CODING_AGENT_DIR=${dest}`,
      "bunx",
      "pi",
      "--provider",
      "x",
    ])
  })

  test("parses wrapper options with operands and retains their exact argv", () => {
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({ packages: [] }),
      "utf8",
    )
    const isolated = `PI_CODING_AGENT_DIR=${dest}`

    expect(
      wrapInteractiveCmdNoVim(
        ["env", "-u", "PI_CODING_AGENT_DIR", "pi", "--provider", "x"],
        { sourceAgentDir: source, destDir: dest },
      ),
    ).toEqual([
      "env",
      "-u",
      "PI_CODING_AGENT_DIR",
      isolated,
      "pi",
      "--provider",
      "x",
    ])
    expect(
      wrapInteractiveCmdNoVim(["env", "--unset=PI_CODING_AGENT_DIR", "pi"], {
        sourceAgentDir: source,
        destDir: dest,
      }),
    ).toEqual(["env", "--unset=PI_CODING_AGENT_DIR", isolated, "pi"])
    expect(
      wrapInteractiveCmdNoVim(["bunx", "--bun", "pi", "--provider", "x"], {
        sourceAgentDir: source,
        destDir: dest,
      }),
    ).toEqual(["env", isolated, "bunx", "--bun", "pi", "--provider", "x"])
    expect(
      wrapInteractiveCmdNoVim(["env", "-i", "pi"], {
        sourceAgentDir: source,
        destDir: dest,
      }),
    ).toEqual(["env", "-i", isolated, "pi"])
    expect(
      wrapInteractiveCmdNoVim(["env", "--ignore-environment", "pi"], {
        sourceAgentDir: source,
        destDir: dest,
      }),
    ).toEqual(["env", "--ignore-environment", isolated, "pi"])
    expect(
      wrapInteractiveCmdNoVim(["bunx", "--no-install", "pi"], {
        sourceAgentDir: source,
        destDir: dest,
      }),
    ).toEqual(["env", isolated, "bunx", "--no-install", "pi"])
  })

  test("preserves documented wrapper argv from the supported table", () => {
    const cases: string[][] = [
      ["env", "-v", "pi"],
      ["env", "--debug", "pi"],
      ["env", "-C", "/tmp", "pi"],
      ["env", "--chdir", "/tmp", "pi"],
      ["env", "-P", "/bin", "pi"],
      ["env", "-S", "", "pi"],
      ["env", "--split-string", "", "pi"],
      ["bunx", "--verbose", "pi"],
      ["bunx", "--silent", "pi"],
      ["bunx", "-p", "provider-package", "pi"],
      ["bunx", "--package", "provider-package", "pi"],
      ["bunx", "--package=provider-package", "pi"],
    ]
    const source = tmp()
    const dest = path.join(tmp(), "role-agent")
    fs.writeFileSync(
      path.join(source, "settings.json"),
      JSON.stringify({ packages: [] }),
      "utf8",
    )
    const isolated = `PI_CODING_AGENT_DIR=${dest}`
    for (const cmd of cases) {
      const piIndex = cmd.indexOf("pi")
      const expected =
        cmd[0] === "env"
          ? [...cmd.slice(0, piIndex), isolated, ...cmd.slice(piIndex)]
          : ["env", isolated, ...cmd]

      expect(isPiCmd(cmd)).toBe(true)
      expect(
        wrapInteractiveCmdNoVim(cmd, {
          sourceAgentDir: source,
          destDir: dest,
        }),
      ).toEqual(expected)
    }
  })

  test("does not claim ambiguous wrapper forms are Pi commands", () => {
    expect(isPiCmd(["env", "-S", "pi --provider x"])).toBe(false)
    expect(isPiCmd(["env", "-u", "pi"])).toBe(false)
    expect(isPiCmd(["env", "-C", "pi"])).toBe(false)
    expect(isPiCmd(["env", "-P", "pi"])).toBe(false)
    expect(isPiCmd(["env", "--split-string", "pi"])).toBe(false)
    expect(isPiCmd(["bunx", "-p", "pi"])).toBe(false)
    expect(isPiCmd(["bunx", "--package", "pi"])).toBe(false)
    expect(isPiCmd(["bunx", "--package=", "pi"])).toBe(false)
    expect(isPiCmd(["bunx", "--unknown", "pi"])).toBe(false)
  })
})
