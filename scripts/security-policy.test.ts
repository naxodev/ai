import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"

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
