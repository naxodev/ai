import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Exit, Option } from "effect"
import { ConfigError } from "../errors.ts"
import {
  FileSystem,
  FileSystemLive,
  PERSISTED_INPUT_MAX_BYTES,
} from "./file-system.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

function temp(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name))
  roots.push(root)
  return root
}

function secureWrite(root: string, destination: string, content: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem
      yield* fileSystem.writeProjectFile(root, destination, content)
    }).pipe(Effect.provide(FileSystemLive)),
  )
}

function secureMkdir(root: string, destination: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem
      yield* fileSystem.mkdirProject(root, destination)
    }).pipe(Effect.provide(FileSystemLive)),
  )
}

function trustedGlobalWrite(
  home: string,
  destination: string,
  content: string,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem
      yield* fileSystem.writeTrustedGlobalFile(home, destination, content)
    }).pipe(Effect.provide(FileSystemLive)),
  )
}

function secureRead(root: string, source: string, limit?: number) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem
      return yield* fileSystem.readProjectFile(root, source, limit)
    }).pipe(Effect.provide(FileSystemLive)),
  )
}

function trustedGlobalRead(home: string, source: string, limit?: number) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem
      return yield* fileSystem.readTrustedGlobalFile(home, source, limit)
    }).pipe(Effect.provide(FileSystemLive)),
  )
}

describe("bounded persisted-input reads", () => {
  test("counts UTF-8 bytes and accepts an exact multibyte boundary", async () => {
    const project = temp("apnea-bounded-project-")
    const target = path.join(project, ".apnea", "state.json")
    fs.mkdirSync(path.dirname(target))
    const exact = "é".repeat(4)
    fs.writeFileSync(target, exact)

    expect(await secureRead(project, target, 8)).toBe(exact)
    await expect(secureRead(project, target, 7)).rejects.toThrow(
      "exceeds 7 byte limit",
    )
  })

  test("uses the practical 1 MiB default", async () => {
    const home = temp("apnea-bounded-home-")
    const target = path.join(home, ".config", "apnea", "config.json")
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, "x".repeat(PERSISTED_INPUT_MAX_BYTES + 1))

    await expect(trustedGlobalRead(home, target)).rejects.toThrow(
      `exceeds ${PERSISTED_INPUT_MAX_BYTES} byte limit`,
    )
  })

  test("refuses directories and other non-regular project inputs", async () => {
    const project = temp("apnea-special-project-")
    const target = path.join(project, ".apnea")
    fs.mkdirSync(target)

    await expect(secureRead(project, target)).rejects.toThrow("regular file")
  })

  test("refuses a FIFO without blocking where FIFOs are supported", async () => {
    if (process.platform === "win32") return
    const project = temp("apnea-fifo-project-")
    const target = path.join(project, ".apnea", "state.json")
    fs.mkdirSync(path.dirname(target))
    const created = Bun.spawnSync(["mkfifo", target])
    if (created.exitCode !== 0) return

    await expect(secureRead(project, target)).rejects.toThrow("regular file")
  })
})

describe("FileSystem.writeProjectFile", () => {
  test("a symlinked .apnea directory cannot alter an outside target", async () => {
    const parent = temp("apnea-secure-parent-")
    const project = path.join(parent, "project")
    const outside = path.join(parent, "outside")
    fs.mkdirSync(project)
    fs.mkdirSync(outside)
    const outsideConfig = path.join(outside, "config.json")
    fs.writeFileSync(outsideConfig, "outside\n")
    fs.symlinkSync(outside, path.join(project, ".apnea"))

    await expect(
      secureWrite(
        project,
        path.join(project, ".apnea", "config.json"),
        "project\n",
      ),
    ).rejects.toThrow("symlink")
    expect(fs.readFileSync(outsideConfig, "utf8")).toBe("outside\n")
  })

  test("a symlinked config destination cannot alter an outside target", async () => {
    const project = temp("apnea-secure-project-")
    const outside = temp("apnea-secure-outside-")
    fs.mkdirSync(path.join(project, ".apnea"))
    const outsideConfig = path.join(outside, "config.json")
    fs.writeFileSync(outsideConfig, "outside\n")
    fs.symlinkSync(outsideConfig, path.join(project, ".apnea", "config.json"))

    await expect(
      secureWrite(
        project,
        path.join(project, ".apnea", "config.json"),
        "project\n",
      ),
    ).rejects.toThrow("symlink")
    expect(fs.readFileSync(outsideConfig, "utf8")).toBe("outside\n")
  })

  test("reports a symlink refusal as a config error, not a defect", async () => {
    const project = temp("apnea-secure-error-")
    const outside = temp("apnea-secure-error-outside-")
    fs.symlinkSync(outside, path.join(project, ".apnea"))

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem
        yield* fileSystem.writeProjectFile(
          project,
          path.join(project, ".apnea", "config.json"),
          "project\n",
        )
      }).pipe(Effect.provide(FileSystemLive)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Exit.findErrorOption(exit)
      expect(Option.isSome(error)).toBe(true)
      if (Option.isSome(error)) expect(error.value).toBeInstanceOf(ConfigError)
    }
  })

  test("allows symlinked ancestry above the project root", async () => {
    const parent = temp("apnea-secure-ancestry-")
    const realParent = path.join(parent, "real")
    const linkedParent = path.join(parent, "linked")
    const project = path.join(linkedParent, "project")
    fs.mkdirSync(path.join(realParent, "project"), { recursive: true })
    fs.symlinkSync(realParent, linkedParent)

    const destination = path.join(project, ".apnea", "config.json")
    await secureWrite(project, destination, "project\n")

    expect(fs.readFileSync(destination, "utf8")).toBe("project\n")
  })

  test("runtime directory creation cannot escape through .apnea", async () => {
    const parent = temp("apnea-secure-mkdir-")
    const project = path.join(parent, "project")
    const outside = path.join(parent, "outside")
    fs.mkdirSync(project)
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(project, ".apnea"))

    await expect(
      secureMkdir(
        project,
        path.join(project, ".apnea", "artifacts", "phase-01"),
      ),
    ).rejects.toThrow("symlink")
    expect(fs.readdirSync(outside)).toEqual([])
  })

  test("a symlinked AGENTS.md cannot overwrite an outside file", async () => {
    const parent = temp("apnea-secure-agents-")
    const project = path.join(parent, "project")
    const outside = path.join(parent, "outside-agents.md")
    fs.mkdirSync(project)
    fs.writeFileSync(outside, "outside\n")
    fs.symlinkSync(outside, path.join(project, "AGENTS.md"))

    await expect(
      secureWrite(project, path.join(project, "AGENTS.md"), "apnea\n"),
    ).rejects.toThrow("symlink")
    expect(fs.readFileSync(outside, "utf8")).toBe("outside\n")
  })
})

describe("FileSystem.writeTrustedGlobalFile", () => {
  test("atomically replaces a regular config and preserves its mode", async () => {
    const home = temp("apnea-global-home-")
    const target = path.join(home, ".config", "apnea", "config.json")
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, "old\n", { mode: 0o640 })

    await trustedGlobalWrite(home, target, "merged\n")

    expect(fs.readFileSync(target, "utf8")).toBe("merged\n")
    if (process.platform !== "win32") {
      expect(fs.statSync(target).mode & 0o777).toBe(0o640)
    }
    expect(
      fs
        .readdirSync(path.dirname(target))
        .filter((name) => name.endsWith(".tmp")),
    ).toEqual([])
  })

  test("refuses symlink components and destinations without changing outside files", async () => {
    const parent = temp("apnea-global-symlink-")
    const home = path.join(parent, "home")
    const outside = path.join(parent, "outside")
    fs.mkdirSync(home)
    fs.mkdirSync(outside)
    const outsideConfig = path.join(outside, "config.json")
    fs.writeFileSync(outsideConfig, "outside\n")
    fs.symlinkSync(outside, path.join(home, ".config"))

    await expect(
      trustedGlobalWrite(
        home,
        path.join(home, ".config", "apnea", "config.json"),
        "unsafe\n",
      ),
    ).rejects.toThrow("symlink")
    expect(fs.readFileSync(outsideConfig, "utf8")).toBe("outside\n")

    fs.rmSync(path.join(home, ".config"))
    fs.mkdirSync(path.join(home, ".config", "apnea"), { recursive: true })
    fs.symlinkSync(
      outsideConfig,
      path.join(home, ".config", "apnea", "config.json"),
    )
    await expect(
      trustedGlobalWrite(
        home,
        path.join(home, ".config", "apnea", "config.json"),
        "unsafe\n",
      ),
    ).rejects.toThrow("symlink")
    expect(fs.readFileSync(outsideConfig, "utf8")).toBe("outside\n")
  })

  test("rejects a non-directory global path component", async () => {
    const home = temp("apnea-global-malformed-")
    fs.writeFileSync(path.join(home, ".config"), "not a directory\n")

    await expect(
      trustedGlobalWrite(
        home,
        path.join(home, ".config", "apnea", "config.json"),
        "unsafe\n",
      ),
    ).rejects.toThrow("not a safe directory")
    expect(fs.readFileSync(path.join(home, ".config"), "utf8")).toBe(
      "not a directory\n",
    )
  })
})
