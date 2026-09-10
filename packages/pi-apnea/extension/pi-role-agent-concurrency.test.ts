import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { materializePiRoleAgentDir } from "./pi-role-agent.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-role-concurrency-"))
  roots.push(root)
  const dest = path.join(root, "roles")
  function source(name: string) {
    const dir = path.join(root, name)
    fs.mkdirSync(path.join(dir, "extensions"), { recursive: true })
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        defaultProvider: name,
        packages: [`npm:${name}`, "npm:pi-vimmode"],
      }),
    )
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ fixture: name }),
    )
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({ fixture: name }),
    )
    fs.writeFileSync(path.join(dir, "extensions", `${name}.ts`), name)
    return dir
  }
  return { root, dest, source }
}

function assertSource(dir: string, name: string) {
  expect(
    JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")),
  ).toEqual({
    defaultProvider: name,
    packages: [`npm:${name}`],
    extensions: [],
  })
  for (const file of ["auth.json", "models.json"]) {
    expect(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))).toEqual({
      fixture: name,
    })
  }
  expect(fs.readdirSync(path.join(dir, "extensions"))).toEqual([`${name}.ts`])
  expect(
    fs.readFileSync(path.join(dir, "extensions", `${name}.ts`), "utf8"),
  ).toBe(name)
}

// A separate process allows real synchronous materializers to overlap. The
// filesystem barrier pauses after settings/extensions, before identity links.
const caller = `
import { spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { materializePiRoleAgentDir } from ${JSON.stringify(path.join(import.meta.dir, "pi-role-agent.ts"))}
const [source, dest, ready, release] = process.argv.slice(1)
const symlink = fs.symlinkSync
spyOn(fs, "symlinkSync").mockImplementation((src, target, ...args) => {
  if (path.basename(target) === "auth.json") {
    fs.writeFileSync(ready, "ready")
    const deadline = Date.now() + 10000
    while (!fs.existsSync(release)) {
      if (Date.now() > deadline) throw new Error("barrier timed out")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  return symlink(src, target, ...args)
})
console.log(materializePiRoleAgentDir({ sourceAgentDir: source, destDir: dest }))
`

test("overlapping repositories keep complete source-specific resources and retain earlier panes", async () => {
  const { root, dest, source } = fixture()
  const sourceA = source("provider-a")
  const sourceB = source("provider-b")
  const earlier = materializePiRoleAgentDir({
    sourceAgentDir: sourceA,
    destDir: dest,
  })
  const ready = path.join(root, "ready")
  const release = path.join(root, "release")
  const child = Bun.spawn(
    [process.execPath, "--eval", caller, sourceA, dest, ready, release],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const deadline = Date.now() + 10000
    while (!fs.existsSync(ready)) {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill()
        await child.exited
        throw new Error(
          `caller did not reach barrier: ${await new Response(child.stderr).text()}`,
        )
      }
      await Bun.sleep(10)
    }
    expect(child.exitCode).toBeNull()
    expect(
      fs.readdirSync(dest).filter((name) => name.startsWith("snapshot-")),
    ).toEqual([path.basename(earlier)])
    assertSource(earlier, "provider-a")
    const second = materializePiRoleAgentDir({
      sourceAgentDir: sourceB,
      destDir: dest,
    })
    assertSource(second, "provider-b")
    assertSource(earlier, "provider-a")
    fs.writeFileSync(release, "release")
    expect(await child.exited).toBe(0)
    const first = (await new Response(child.stdout).text()).trim()
    assertSource(first, "provider-a")
    assertSource(second, "provider-b")
    expect(new Set([earlier, first, second]).size).toBe(3)
  } finally {
    fs.writeFileSync(release, "release")
    child.kill()
    await child.exited
  }
}, 20000)

test.each(
  (["identity", "publication", "directory sync"] as const).filter(
    (failure) => failure !== "directory sync" || process.platform !== "win32",
  ),
)(
  "failed %s cleans only its unpublished snapshot and retains active panes",
  (failure) => {
    const { dest, source } = fixture()
    const sourceA = source("provider-a")
    const sourceB = source("provider-b")
    const earlier = materializePiRoleAgentDir({
      sourceAgentDir: sourceA,
      destDir: dest,
    })
    const entries = fs.readdirSync(dest)
    const symlink = fs.symlinkSync
    const copyFile = fs.copyFileSync
    const rename = fs.renameSync
    const open = fs.openSync
    const spies = [
      spyOn(fs, "symlinkSync").mockImplementation((src, target, type) => {
        if (
          failure === "identity" &&
          path.basename(String(target)) === "auth.json"
        )
          throw new Error("injected identity failure")
        return symlink(src, target, type)
      }),
      spyOn(fs, "copyFileSync").mockImplementation((src, target, mode) => {
        if (
          failure === "identity" &&
          path.basename(String(target)) === "auth.json"
        )
          throw new Error("injected identity failure")
        return copyFile(src, target, mode)
      }),
      spyOn(fs, "renameSync").mockImplementation((src, target) => {
        if (
          failure === "publication" &&
          path.basename(String(src)).startsWith(".pending-")
        )
          throw new Error("injected publication failure")
        return rename(src, target)
      }),
      spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
        if (failure === "directory sync" && file === dest)
          throw new Error("injected directory sync failure")
        return open(file, flags, mode)
      }),
    ]
    try {
      expect(() =>
        materializePiRoleAgentDir({ sourceAgentDir: sourceB, destDir: dest }),
      ).toThrow(`injected ${failure} failure`)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(fs.readdirSync(dest)).toEqual(entries)
    assertSource(earlier, "provider-a")
    const recovered = materializePiRoleAgentDir({
      sourceAgentDir: sourceB,
      destDir: dest,
    })
    assertSource(recovered, "provider-b")
    assertSource(earlier, "provider-a")
  },
)

test("snapshots share identity updates only with their source and preserve module dependency resolution", async () => {
  const { root, dest, source } = fixture()
  const sourceA = source("provider-a")
  const sourceB = source("provider-b")
  const dependency = path.join(
    sourceA,
    "node_modules",
    "fixture-provider-dependency",
  )
  fs.mkdirSync(dependency, { recursive: true })
  fs.writeFileSync(
    path.join(dependency, "index.js"),
    'module.exports = "source dependency"',
  )
  fs.writeFileSync(
    path.join(sourceA, "extensions", "provider.cjs"),
    'module.exports = require("fixture-provider-dependency")',
  )
  const first = materializePiRoleAgentDir({
    sourceAgentDir: path.relative(process.cwd(), sourceA),
    destDir: dest,
  })
  const second = materializePiRoleAgentDir({
    sourceAgentDir: sourceB,
    destDir: dest,
  })
  expect(fs.realpathSync(path.join(first, "auth.json"))).toBe(
    fs.realpathSync(path.join(sourceA, "auth.json")),
  )
  // Synthetic identity data only. Source replacement and role writes must stay
  // visible rather than freezing an OAuth refresh in a private credential copy.
  const replacement = path.join(root, "replacement.json")
  fs.writeFileSync(replacement, '{"fixture":"refreshed"}')
  fs.renameSync(replacement, path.join(sourceA, "auth.json"))
  expect(fs.readFileSync(path.join(first, "auth.json"), "utf8")).toBe(
    '{"fixture":"refreshed"}',
  )
  fs.writeFileSync(path.join(first, "auth.json"), '{"fixture":"role-update"}')
  expect(fs.readFileSync(path.join(sourceA, "auth.json"), "utf8")).toBe(
    '{"fixture":"role-update"}',
  )
  assertSource(second, "provider-b")

  const child = Bun.spawn(
    [
      "node",
      "-e",
      "console.log(require(process.argv[1]))",
      path.join(first, "extensions", "provider.cjs"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stdout).text()).toBe("source dependency\n")
  expect(await new Response(child.stderr).text()).toBe("")
})

test("a filesystem without symlinks retains the existing copy fallback", () => {
  const { dest, source } = fixture()
  const sourceA = source("provider-a")
  const spy = spyOn(fs, "symlinkSync").mockImplementation(() => {
    throw new Error("symlinks unavailable")
  })
  let snapshot: string
  try {
    snapshot = materializePiRoleAgentDir({
      sourceAgentDir: sourceA,
      destDir: dest,
    })
  } finally {
    spy.mockRestore()
  }
  assertSource(snapshot, "provider-a")
  expect(fs.lstatSync(path.join(snapshot, "auth.json")).isSymbolicLink()).toBe(
    false,
  )
})
