import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ReleaseClient } from "nx/release"
import nx from "../nx.json"

const temporaryWorkspaces: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryWorkspaces.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe("release policy", () => {
  test("a filtered compatible Apnea patch versions only Apnea", async () => {
    const config = structuredClone(nx.release) as ConstructorParameters<
      typeof ReleaseClient
    >[0]
    config.version!.preVersionCommand = ""

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
    expect(projectsVersionData.apnea?.newVersion).toBe("0.1.1")
  })

  test("a coordinated incompatible release preserves the prepared core range", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nx-release-policy-"))
    temporaryWorkspaces.push(workspace)

    const coreManifest = {
      name: "@naxodev/apnea",
      version: "0.1.0",
    }
    const adapterManifest = {
      name: "@naxodev/pi-apnea",
      version: "0.1.0",
      dependencies: { "@naxodev/apnea": "^0.2.0" },
    }
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
