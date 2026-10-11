/** Fake native identities and content only. No live metadata, permission, or discovery. */
import { applicationDiscovery } from "./application-discovery.ts"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { command, compiler, sdk } from "./build.ts"

const fixtureDirectory = join(
  import.meta.dir,
  "dist",
  `harness-fixture-${process.pid}`,
)
await mkdir(fixtureDirectory, { recursive: true })
try {
  const source =
    (await readFile(join(import.meta.dir, "HarnessActions.swift"), "utf8")) +
    "\n" +
    (await readFile(
      join(import.meta.dir, "HarnessActionsFixture.swift"),
      "utf8",
    ))
  const file = join(fixtureDirectory, "main.swift")
  const executable = join(fixtureDirectory, "harness-fixture")
  await writeFile(file, source)
  await command([
    compiler,
    "-sdk",
    sdk,
    "-module-cache-path",
    join(import.meta.dir, "dist/module-cache"),
    "-swift-version",
    "5",
    "-warnings-as-errors",
    file,
    "-o",
    executable,
  ])
  await command([executable])
  console.log("permission setup never launches native work: passed")
} finally {
  await rm(fixtureDirectory, { recursive: true, force: true })
}

for (const [args, expected] of [
  [["--self-test", "application-policy"], 0],
  [["--self-test", "application-flow"], 0],
  [["--protocol", "1", "--capture"], 1],
  [["--prepare-profile"], 1],
] as const) {
  const child = Bun.spawn([applicationDiscovery.helperPath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (stdout.length !== 0 || exit !== expected)
      throw new Error(`Application fixture failed (${exit}): ${stderr}`)
    if (
      expected === 1 &&
      stderr !== '{"event":"music-audio-helper-stop","reason":"arguments"}\n'
    )
      throw new Error("Rejected command crossed the native argument boundary")
    console.log(`${args.join(" ")}: passed (${exit})`)
  } finally {
    clearTimeout(timer)
  }
}
