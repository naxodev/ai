import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkCoverage, lint, sourceFiles } from "./async-lint"

async function fixture(include = ["**/*.ts", "**/*.tsx"]) {
  const root = await mkdtemp(join(tmpdir(), "async-lint-"))
  await Bun.write(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        jsx: "preserve",
        strict: true,
        types: [],
      },
      include,
    }),
  )
  return root
}

test("the real gate rejects floating promises and async void callbacks in production, tests, TSX, and tooling", async () => {
  const root = await fixture()
  try {
    await mkdir(join(root, "tests"))
    await mkdir(join(root, "scripts"))
    await Bun.write(
      join(root, "promise.ts"),
      "export async function work(): Promise<void> {}\n",
    )
    const categories = [
      "production.ts",
      "tests/async.test.ts",
      "tests/lifecycle.test.tsx",
      "scripts/task.tsx",
    ]
    for (const file of categories) {
      const prefix = file.includes("/") ? "../" : "./"
      await Bun.write(
        join(root, file),
        `import { work } from "${prefix}promise";\nwork();\nconst register = (_callback: () => void) => {};\nregister(async () => { await work() });\n`,
      )
    }
    const broken = await lint(root)
    expect(broken.exitCode).toBe(1)
    expect(
      broken.stdout.match(/typescript\(no-floating-promises\)/g),
      broken.stdout + broken.stderr,
    ).toHaveLength(4)
    expect(
      broken.stdout.match(/typescript\(no-misused-promises\)/g),
    ).toHaveLength(4)
    for (const file of categories)
      expect(broken.stdout.replaceAll("\\", "/")).toContain(file)
    expect(broken.files).toBe(5)

    // Awaiting work and handling callback rejection must restore a passing gate.
    for (const file of categories) {
      const prefix = file.includes("/") ? "../" : "./"
      await Bun.write(
        join(root, file),
        `import { work } from "${prefix}promise";\nawait work();\nconst register = (_callback: () => void) => {};\nregister(() => { work().catch(console.error) });\n`,
      )
    }
    const fixed = await lint(root)
    expect(fixed.exitCode).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

test("the gate fails when a compiler include silently omits executable TSX", async () => {
  const root = await fixture(["**/*.ts"])
  try {
    await Bun.write(join(root, "included.ts"), "export {}\n")
    await mkdir(join(root, "tests"))
    await Bun.write(
      join(root, "tests/lifecycle.test.tsx"),
      "Promise.resolve();\n",
    )
    await expect(lint(root)).rejects.toThrow("tests/lifecycle.test.tsx")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("new automation outside a TypeScript project cannot escape lint", async () => {
  const root = await mkdtemp(join(tmpdir(), "async-lint-orphan-"))
  try {
    await Bun.write(join(root, "orphan.ts"), "Promise.resolve();\n")
    await expect(checkCoverage(root, await sourceFiles(root))).rejects.toThrow(
      "No TypeScript project owns orphan.ts",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
