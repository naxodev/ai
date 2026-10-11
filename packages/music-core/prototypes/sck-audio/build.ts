/** Compile and verify only. No capture, registration, or permission request. */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sckHelperIdentifier, sckHelperPath } from "./adapter.ts"

const directory = import.meta.dir
const output = join(directory, "dist")
const compiler =
  "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"
const sdk =
  "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exit !== 0)
      throw new Error(`${args[0]} exited ${exit}: ${stderr || stdout}`)
  } finally {
    clearTimeout(timer)
  }
}

export async function buildSckPrototype() {
  if (process.platform !== "darwin")
    throw new Error("This prototype requires macOS and installed Xcode")
  await mkdir(output, { recursive: true })
  const original = await readFile(
    join(directory, "../../audio/native/MusicAudioHelper.swift"),
    "utf8",
  )
  const marker = "private func main() throws {"
  const split = original.indexOf(marker)
  if (split < 0 || original.indexOf(marker, split + marker.length) >= 0)
    throw new Error(
      "Native helper entrypoint changed; review prototype composition",
    )
  // One generated file shares the existing private lease, identity, ring, and
  // analyzer code. It replaces the entrypoint without editing the real helper.
  const source =
    original.slice(0, split) +
    (await readFile(join(directory, "SckCapture.swift"), "utf8"))
  const sourcePath = join(output, "main.swift")
  const plistPath = join(output, "Info.plist")
  const staged = `${sckHelperPath}.staging.${process.pid}`
  await writeFile(sourcePath, source)
  await writeFile(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${sckHelperIdentifier}</string><key>NSAudioCaptureUsageDescription</key><string>Test Kaset audio visualization with an explicitly selected process.</string></dict></plist>`,
  )
  try {
    await command([
      compiler,
      "-sdk",
      sdk,
      "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos15.2`,
      "-swift-version",
      "5",
      "-warnings-as-errors",
      "-O",
      "-module-cache-path",
      join(output, "module-cache"),
      sourcePath,
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      plistPath,
      "-o",
      staged,
    ])
    await command([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      sckHelperIdentifier,
      staged,
    ])
    await command([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "-R",
      `=identifier "${sckHelperIdentifier}"`,
      staged,
    ])
    await rename(staged, sckHelperPath)
  } finally {
    await rm(staged, { force: true })
  }
}

if (import.meta.main) {
  await buildSckPrototype()
  console.log(`Built prototype only: ${sckHelperPath}`)
}
