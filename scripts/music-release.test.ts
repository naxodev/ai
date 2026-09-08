import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkPublishedCore,
  checkRegistryConsumer,
  checkStagedCore,
} from "./music-release.ts"
import { runBoundedCommand } from "./bounded-process.ts"

test("both hosts reject a staged core that their consumer range cannot install", async () => {
  for (const host of ["opencode-music-player", "pi-music-dock"]) {
    expect(() => checkStagedCore(host, "^0.1.0", "0.2.0")).toThrow("0.2.0")
    expect(() => checkStagedCore(host, "^0.1.0", "0.1.2")).not.toThrow()
  }
})

test("each real package gate rejects an incompatible staged manifest before packing", async () => {
  const root = await mkdtemp(join(tmpdir(), "music-staged-fixture-"))
  try {
    for (const script of ["music-release.ts", "bounded-process.ts"])
      await Bun.write(
        join(root, "scripts", script),
        Bun.file(join(import.meta.dir, script)),
      )
    await Bun.write(
      join(root, "packages/music-core/package.json"),
      JSON.stringify({ name: "@naxodev/music-core", version: "0.2.0" }),
    )
    for (const host of ["opencode-music-player", "pi-music-dock"]) {
      const manifest = await Bun.file(
        join(import.meta.dir, "../packages", host, "package.json"),
      ).json()
      const cwd = join(root, "packages", host)
      await Bun.write(join(cwd, "package.json"), JSON.stringify(manifest))
      const result = await runBoundedCommand(
        [process.execPath, "run", "pack:check"],
        { cwd, label: host, timeoutMs: 5_000 },
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain(
        `${host}: staged @naxodev/music-core@0.2.0 does not satisfy declared range`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("npm registry boundary rejects absent and incompatible packages and tolerates delayed visibility", async () => {
  let scenario = "absent"
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++
      if (scenario === "absent" || (scenario === "delayed" && requests === 1))
        return Response.json({ error: "not found" }, { status: 404 })
      const version = scenario === "incompatible" ? "0.2.0" : "0.1.2"
      return Response.json({
        name: "@naxodev/music-core",
        "dist-tags": { latest: version },
        versions: { [version]: { name: "@naxodev/music-core", version } },
      })
    },
  })
  try {
    const options = { registry: server.url.href, attempts: 2, retryDelayMs: 0 }
    await expect(checkPublishedCore("^0.1.0", options)).rejects.toThrow("E404")
    scenario = "incompatible"
    await expect(checkPublishedCore("^0.1.0", options)).rejects.toThrow(
      "Visible versions: 0.2.0",
    )
    scenario = "delayed"
    requests = 0
    await expect(checkPublishedCore("^0.1.0", options)).resolves.toBe("0.1.2")
    expect(requests).toBe(2)
  } finally {
    server.stop(true)
  }
}, 20_000)

test("consumer gate leaves core to the packed range and rejects an incompatible installed manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "music-consumer-fixture-"))
  const name = "@naxodev/pi-music-dock"
  const manifest = {
    name,
    version: "0.1.0",
    dependencies: { "@naxodev/music-core": "^0.1.0" },
  }
  await Bun.write(join(directory, "package.json"), JSON.stringify(manifest))
  let installedVersion = "0.2.0"
  let root = ""
  try {
    const run: typeof runBoundedCommand = async (args, options) => {
      if (args[1] === "pack")
        return { exitCode: 0, stdout: '[{"filename":"host.tgz"}]', stderr: "" }
      if (args[1] === "install") {
        root = options.cwd!
        const consumer = await Bun.file(join(root, "package.json")).json()
        expect(consumer.overrides).toBeUndefined()
        expect(Object.keys(consumer.dependencies)).toEqual([name])
        expect(consumer.dependencies[name]).toEndWith("host.tgz")
        expect(args).toContain("--workspaces=false")
        expect(options.timeoutMs).toBeLessThanOrEqual(180_000)
        const hostRoot = join(root, "node_modules", name)
        await Bun.write(
          join(hostRoot, "package.json"),
          JSON.stringify(manifest),
        )
        await Bun.write(
          join(hostRoot, "extensions/music-dock/index.ts"),
          'export default api => { for (const name of ["music", "music-next", "music-prev", "music-view", "music-focus"]) api.registerCommand(name) }',
        )
        const coreRoot = join(root, "node_modules/@naxodev/music-core")
        await Bun.write(
          join(coreRoot, "package.json"),
          JSON.stringify({
            name: "@naxodev/music-core",
            version: installedVersion,
            exports: "./index.ts",
          }),
        )
        await Bun.write(join(coreRoot, "index.ts"), "export {}")
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      return runBoundedCommand(args, options)
    }
    await expect(
      checkRegistryConsumer("pi-music-dock", directory, run),
    ).rejects.toThrow("Installed core violates declared range")
    expect(await Bun.file(join(root, "package.json")).exists()).toBe(false)
    installedVersion = "0.1.2"
    await expect(
      checkRegistryConsumer("pi-music-dock", directory, run),
    ).resolves.toContain("registry @naxodev/music-core@0.1.2")
    expect(await Bun.file(join(root, "package.json")).exists()).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("release wiring keeps registry consumers before new publication and after the idempotency check", async () => {
  const workflow = await Bun.file(
    join(import.meta.dir, "../.github/workflows/publish.yml"),
  ).text()
  const check = workflow.indexOf(
    "- name: Verify published music core and isolated consumer",
  )
  expect(check).toBeGreaterThan(
    workflow.indexOf("- name: Check whether version is already published"),
  )
  expect(check).toBeLessThan(workflow.indexOf("- name: Publish source package"))
  expect(
    workflow.slice(check, workflow.indexOf("- name: Publish source package")),
  ).toContain("steps.published.outputs.skip != 'true'")
  for (const host of ["opencode-music-player", "pi-music-dock"]) {
    const manifest = await Bun.file(
      join(import.meta.dir, "../packages", host, "package.json"),
    ).json()
    expect(manifest.scripts["pack:check"]).toContain(
      `music-release.ts ${host} --staged-only`,
    )
    expect(manifest.scripts["prepublish:core"]).toEndWith(
      `music-release.ts ${host}`,
    )
  }
})

test("absent and incompatible registry versions block publication with recovery instructions", async () => {
  for (const versions of [[], ["0.2.0"], ["0.1.3-beta.1"]]) {
    let calls = 0
    await expect(
      checkPublishedCore("^0.1.0", {
        attempts: 2,
        retryDelayMs: 0,
        run: async () => {
          calls++
          return { exitCode: 0, stdout: JSON.stringify(versions), stderr: "" }
        },
      }),
    ).rejects.toThrow("Publish a compatible @naxodev/music-core first")
    expect(calls).toBe(2)
  }
})

test("registry propagation retries errors and incompatible versions until a compatible version appears", async () => {
  let calls = 0
  await expect(
    checkPublishedCore("^0.1.0", {
      attempts: 3,
      retryDelayMs: 0,
      run: async () => {
        calls++
        if (calls === 1) return { exitCode: 1, stdout: "", stderr: "E404" }
        return {
          exitCode: 0,
          stdout: JSON.stringify(calls === 2 ? ["0.2.0"] : ["0.1.2"]),
          stderr: "",
        }
      },
    }),
  ).resolves.toBe("0.1.2")
  expect(calls).toBe(3)
})
