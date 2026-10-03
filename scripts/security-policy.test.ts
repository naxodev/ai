import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

type DependencyGroups = {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
type AuditLock = {
  workspaces: Record<string, DependencyGroups>
  packages: Record<string, [string, string, DependencyGroups?, ...unknown[]]>
}

test("security overrides remove all affected serializer and TOML resolutions", async () => {
  const manifest = (await Bun.file("package.json").json()) as {
    overrides: Record<string, string>
  }
  const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text()) as AuditLock
  const resolutions = Object.values(lock.packages).map(([name]) => name)
  // A nested affected copy defeats the override even when the root copy is fixed.
  for (const [name, version] of [
    ["seroval", "1.6.8"],
    ["smol-toml", "1.9.0"],
  ] as const) {
    expect(manifest.overrides[name]).toBe(version)
    expect(resolutions.filter((value) => value.startsWith(`${name}@`))).toEqual(
      [`${name}@${version}`],
    )
  }
  expect(resolutions.filter((value) => value.startsWith("solid-js@"))).toEqual([
    "solid-js@1.9.15",
  ])
})

test("Solid's serializer still round-trips typed arrays and collections with the security override", () => {
  const require = createRequire(
    join(process.cwd(), "packages/opencode-music-player/package.json"),
  )
  const solidRequire = createRequire(require.resolve("solid-js"))
  const seroval = solidRequire("seroval") as {
    toJSON(value: unknown): unknown
    fromJSON(value: unknown): unknown
  }
  const value = {
    bytes: new Uint8Array([0, 127, 255]),
    labels: new Set(["artwork", "track"]),
    metadata: new Map([["title", "Track"]]),
  }

  expect(seroval.fromJSON(seroval.toJSON(value))).toEqual(value)
})

test("Solid's serializer rejects array-like backing buffers while preserving valid views", () => {
  const require = createRequire(
    join(process.cwd(), "packages/opencode-music-player/package.json"),
  )
  const solidRequire = createRequire(require.resolve("solid-js"))
  const seroval = solidRequire("seroval") as {
    toJSON(value: unknown): { t: Record<string, unknown> }
    fromJSON(value: unknown): unknown
  }
  const valid = seroval.toJSON(new Uint8Array([1, 2, 3]))
  expect(seroval.fromJSON(valid)).toEqual(new Uint8Array([1, 2, 3]))
  const backing = valid.t.f as { i: number }
  valid.t.f = {
    ...seroval.toJSON({ length: 3 }).t,
    i: backing.i,
  }
  // A small array-like object reproduces the allocation path without an OOM payload.
  expect(() => seroval.fromJSON(valid)).toThrow()
})

test("Nx's installed TOML parser is patched and preserves dotted keys, tables, and dates", async () => {
  const require = createRequire(import.meta.url)
  const nxRequire = createRequire(require.resolve("nx/package.json"))
  const installed = (await Bun.file(
    join(dirname(nxRequire.resolve("smol-toml")), "../package.json"),
  ).json()) as { version: string }
  // Compatibility alone cannot detect a stale link to the affected parser.
  expect(installed.version).toBe("1.9.0")
  const toml = nxRequire("smol-toml") as {
    parse(input: string): Record<string, unknown>
    stringify(value: Record<string, unknown>): string
  }
  const manifest = toml.parse(`
package.name = "fixture"
package.version = "0.1.0"
date = 2026-10-09
[[bin]]
name = "fixture"
path = "src/main.rs"
[dependencies]
serde = { version = "1.0", features = ["derive"] }
`)
  expect(manifest).toMatchObject({
    package: { name: "fixture", version: "0.1.0" },
    bin: [{ name: "fixture", path: "src/main.rs" }],
    dependencies: { serde: { version: "1.0", features: ["derive"] } },
  })
  // 1.9 returns null-prototype tables. Consumers must retain data through a round trip.
  expect(toml.parse(toml.stringify(manifest))).toEqual(manifest)
})

test("the cache advisory exception requires the reviewed private-cache consumer", async () => {
  const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text()) as AuditLock
  const groups = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ] as const
  const resolutions = Object.values(lock.packages)

  // An added caller or changed version needs a new reachability assessment.
  expect(
    resolutions
      .filter(([name]) => name.startsWith("http-cache-semantics@"))
      .map(([name]) => name),
  ).toEqual(["http-cache-semantics@4.2.0"])
  expect(
    resolutions
      .filter(([, , metadata]) =>
        groups.some(
          (group) => metadata?.[group]?.["http-cache-semantics"] !== undefined,
        ),
      )
      .map(([name]) => name),
  ).toEqual(["make-fetch-happen@15.0.6"])
  for (const workspace of Object.values(lock.workspaces)) {
    for (const group of groups)
      expect(workspace[group]?.["http-cache-semantics"]).toBeUndefined()
  }

  // Pin the reviewed implementation, not a text search for `shared: false`.
  // Changes to how it constructs or restores policies must stop the exception.
  const policy = await Bun.file(
    "node_modules/.bun/make-fetch-happen@15.0.6/node_modules/make-fetch-happen/lib/cache/policy.js",
  ).arrayBuffer()
  expect(
    createHash("sha256").update(new Uint8Array(policy)).digest("hex"),
  ).toBe("2014cf549fceb8808cba81e8760315b9060f502b6c62b7cb79e1b024abde54c3")
})

test("patched brace expansion remains compatible with older Minimatch consumers", async () => {
  const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text()) as AuditLock

  expect(lock.packages["brace-expansion"]?.[0]).toBe("brace-expansion@5.0.12")
  expect(
    Object.values(lock.packages).some(([resolution]) =>
      resolution.startsWith("brace-expansion@5.0.8"),
    ),
  ).toBe(false)

  for (const [version, moduleDirectory] of [
    ["8.0.7", "mjs"],
    ["9.0.9", "esm"],
  ]) {
    const minimatch = await import(
      join(
        process.cwd(),
        `node_modules/.bun/minimatch@${version}/node_modules/minimatch/dist/${moduleDirectory}/index.js`,
      )
    )
    expect(minimatch.braceExpand("{alpha,beta}")).toEqual(["alpha", "beta"])
  }
})
