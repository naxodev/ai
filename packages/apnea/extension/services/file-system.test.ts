import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Exit, Option } from "effect"
import { ConfigError } from "../errors.ts"
import { FileSystem, FileSystemLive } from "./file-system.ts"

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
})
