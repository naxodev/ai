import { expect, test } from "bun:test"
import { join } from "node:path"

test("patched brace expansion remains compatible with older Minimatch consumers", async () => {
  const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text()) as {
    packages: Record<
      string,
      [string, string, { dependencies?: Record<string, string> }?]
    >
  }

  expect(lock.packages["brace-expansion"]?.[0]).toBe("brace-expansion@5.0.9")
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
