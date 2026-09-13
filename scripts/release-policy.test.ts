import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReleaseClient } from "nx/release"
import nx from "../nx.json"
import workspace from "../package.json"

const temporaryWorkspaces: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryWorkspaces.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe("release policy", () => {
  test("pack gates cannot delete shared build output while another target archives it", async () => {
    const [publish, ci, contributing] = await Promise.all([
      readFile(
        new URL("../.github/workflows/publish.yml", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
      readFile(new URL("../CONTRIBUTING.md", import.meta.url), "utf8"),
    ])
    const workflowCommands = `${publish}\n${ci}`
      .split("\n")
      .filter((line) => /run: bunx nx (run-many|affected)\b/.test(line))
    const documentedCommands = [
      ...contributing.matchAll(/`(bunx nx (?:run-many|affected)[^`]+)`/g),
    ].map((match) => match[1]!)
    expect(workflowCommands.length).toBeGreaterThan(0)
    expect(documentedCommands.length).toBeGreaterThan(0)
    const commands = [
      workspace.scripts.check,
      nx.release.version.preVersionCommand,
      ...workflowCommands,
      ...documentedCommands,
    ]
    for (const command of commands) {
      // Separate shell stages finish before the next stage can pack the same project.
      for (const stage of command.split("&&")) {
        if (!/\bnx (run-many|affected)\b/.test(stage)) continue
        const targets =
          stage
            .match(/(?:-t|--targets?)\s+(.+?)(?=\s+--|$)/)?.[1]
            ?.trim()
            .split(/[\s,]+/) ?? []
        expect(targets.length, stage).toBeGreaterThan(0)
        const writers = targets.filter((target) =>
          ["build", "package:check", "smoke"].includes(target),
        )
        // Smokes can also pack a shared dependency such as music-core.
        if (writers.length > 1 || targets.includes("smoke"))
          expect(
            stage,
            "Concurrent pack targets can remove dist before npm reads it",
          ).toMatch(/(?:^|\s)--parallel(?:=|\s+)1(?:\s|$)/)
      }
    }
  })

  test("a filtered compatible Apnea patch versions only Apnea", async () => {
    const config = structuredClone(nx.release) as ConstructorParameters<
      typeof ReleaseClient
    >[0]
    config.version!.preVersionCommand = ""
    config.version!.conventionalCommits = false
    config.version!.currentVersionResolver = "disk"

    const { projectsVersionData } = await new ReleaseClient(
      config,
      true,
    ).releaseVersion({
      specifier: "patch",
      projects: ["apnea"],
      dryRun: true,
      stageChanges: false,
      gitCommit: false,
      gitTag: false,
      gitPush: false,
    })

    expect(Object.keys(projectsVersionData)).toEqual(["apnea"])
    // Derive the expectation from the manifest so a released version bump
    // does not break this policy check.
    const manifest = JSON.parse(
      await readFile(
        new URL("../packages/apnea/package.json", import.meta.url),
        "utf8",
      ),
    ) as { version: string }
    const [major, minor, patch] = manifest.version.split(".").map(Number)
    if (major === undefined || minor === undefined || patch === undefined) {
      throw new Error(`Expected a three-part version, got ${manifest.version}`)
    }
    expect(projectsVersionData.apnea?.newVersion).toBe(
      `${major}.${minor}.${patch + 1}`,
    )
  })

  test("a coordinated incompatible release preserves the installable staged state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nx-release-policy-"))
    temporaryWorkspaces.push(workspace)

    const coreManifest = {
      name: "@naxodev/apnea",
      version: "0.2.0",
    }
    const adapterManifest = {
      name: "@naxodev/pi-apnea",
      version: "0.1.0",
      dependencies: { "@naxodev/apnea": "^0.2.0" },
    }
    expect(
      Bun.semver.satisfies(
        coreManifest.version,
        adapterManifest.dependencies["@naxodev/apnea"],
      ),
      "the staged core must satisfy the adapter before Nx versions the adapter",
    ).toBe(true)
    const fixtureFiles: Record<string, unknown> = {
      "package.json": {
        name: "release-policy-fixture",
        private: true,
        workspaces: ["packages/*"],
      },
      "nx.json": {
        release: {
          projectsRelationship: "independent",
          groups: {
            apnea: { projects: ["apnea"] },
            "pi-apnea": { projects: ["pi-apnea"] },
          },
          version: {
            useLegacyVersioning: false,
            updateDependents: "auto",
            fallbackCurrentVersionResolver: "disk",
            manifestRootsToUpdate: ["{projectRoot}"],
          },
        },
      },
      "packages/apnea/package.json": coreManifest,
      "packages/apnea/project.json": {
        name: "apnea",
        projectType: "library",
      },
      "packages/pi-apnea/package.json": adapterManifest,
      "packages/pi-apnea/project.json": {
        name: "pi-apnea",
        projectType: "library",
        implicitDependencies: ["apnea"],
      },
    }

    for (const [path, contents] of Object.entries(fixtureFiles)) {
      const absolutePath = join(workspace, path)
      await Bun.write(absolutePath, `${JSON.stringify(contents, null, 2)}\n`)
    }
    await symlink(
      join(import.meta.dir, "../node_modules"),
      join(workspace, "node_modules"),
    )

    async function runReleaseFixture() {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "release-policy-fixture.ts")],
        {
          cwd: workspace,
          env: { ...Bun.env, NX_DAEMON: "false" },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { exitCode, stdout, stderr }
    }

    const { exitCode, stdout, stderr } = await runReleaseFixture()
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)

    const marker = "__NX_RELEASE_RESULT__"
    const resultLine = stdout
      .split("\n")
      .find((line) => line.startsWith(marker))
    expect(resultLine).toBeDefined()
    const projectsVersionData = JSON.parse(resultLine!.slice(marker.length))

    expect(Object.keys(projectsVersionData).sort()).toEqual([
      "apnea",
      "pi-apnea",
    ])
    expect(projectsVersionData.apnea.newVersion).toBe("0.2.0")
    expect(projectsVersionData["pi-apnea"].newVersion).toBe("0.2.0")
    expect(
      JSON.parse(
        await readFile(join(workspace, "packages/apnea/package.json"), "utf8"),
      ),
    ).toEqual(coreManifest)
    expect(
      JSON.parse(
        await readFile(
          join(workspace, "packages/pi-apnea/package.json"),
          "utf8",
        ),
      ),
    ).toEqual(adapterManifest)

    await Bun.write(
      join(workspace, "packages/pi-apnea/package.json"),
      `${JSON.stringify(
        {
          ...adapterManifest,
          dependencies: { "@naxodev/apnea": "^0.1.0" },
        },
        null,
        2,
      )}\n`,
    )
    const staleRangeRelease = await runReleaseFixture()
    expect(staleRangeRelease.exitCode).not.toBe(0)
  })
})
