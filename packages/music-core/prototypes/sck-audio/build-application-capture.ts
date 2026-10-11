/** Build only. Reuse the proven profile without refreshing it or starting native work. */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { command, compiler, sdk } from "./build.ts"
import { applicationCapture } from "./application-capture.ts"
import {
  ApplicationProfile,
  applicationProfileDigest,
} from "./application-profile.ts"

const before = (source: string, marker: string) => {
  const offset = source.indexOf(marker)
  if (offset < 0 || source.indexOf(marker, offset + marker.length) >= 0)
    throw new Error("Native composition boundary changed: " + marker)
  return source.slice(0, offset)
}

export async function buildApplicationCapture() {
  if (process.platform !== "darwin")
    throw new Error("Application capture requires macOS")
  const output = join(import.meta.dir, "dist")
  if (
    await Bun.file(
      join(
        import.meta.dir,
        applicationCapture.evidenceDirectory,
        "attempt.json",
      ),
    ).exists()
  )
    throw new Error(
      "Capture was attempted; preserve the reviewed artifacts before preparing another attempt",
    )
  const archived = await readFile(
    join(
      output,
      "application-discovery-evidence/kaset-application-profile.json",
    ),
  )
  const digest = applicationProfileDigest(archived)
  if (
    archived.byteLength > 16384 ||
    digest !== applicationCapture.discoveryProfileDigest
  )
    throw new Error(
      "The proven discovery profile changed; review a new profile instead of refreshing it",
    )
  const profile = Schema.decodeUnknownSync(ApplicationProfile)(
    JSON.parse(archived.toString("utf8")),
  )
  if (profile.architecture !== (process.arch === "arm64" ? "arm64" : "x86_64"))
    throw new Error("Profile architecture differs from this helper")
  const original = await readFile(
    join(import.meta.dir, "../../audio/native/MusicAudioHelper.swift"),
    "utf8",
  )
  // Includes the bounded sample ring and analyzer, but no process-tap implementation.
  const primitives = before(original, "private final class Cleanup")
  if (/AudioHardwareCreateProcessTap|AudioDeviceStart/.test(primitives))
    throw new Error("Process tap crossed the application boundary")
  const sck = await readFile(join(import.meta.dir, "SckCapture.swift"), "utf8")
  const runtime = before(sck, "// Exact process match only.")
  const fixtureStart = sck.indexOf("private func pcmFixture(")
  if (fixtureStart < 0) throw new Error("PCM fixture boundary changed")
  const pcmFixture = before(
    sck.slice(fixtureStart),
    "private func syntheticSck(",
  )
  const identity = before(
    await readFile(join(import.meta.dir, "ApplicationDiscovery.swift"), "utf8"),
    "private func applicationMain() throws {",
  )
  const implementation = await readFile(
    join(import.meta.dir, "ApplicationCapture.swift"),
    "utf8",
  )
  const constants = `private let applicationProfilePath = ${JSON.stringify(applicationCapture.profilePath)}\nprivate let applicationProfileDigest = ${JSON.stringify(digest)}\n`
  const source =
    primitives +
    constants +
    (await readFile(join(import.meta.dir, "SckPCM.swift"), "utf8")) +
    runtime +
    pcmFixture +
    identity +
    implementation
  await mkdir(output, { recursive: true })
  await writeFile(applicationCapture.profilePath, archived, { mode: 0o600 })
  const sourcePath = join(output, "application-capture-main.swift")
  await writeFile(sourcePath, source)
  const staged = `${applicationCapture.helperPath}.staging.${process.pid}`
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
      "-o",
      staged,
    ])
    await command([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      applicationCapture.helperIdentifier,
      staged,
    ])
    await command([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "-R",
      `=identifier "${applicationCapture.helperIdentifier}"`,
      staged,
    ])
    await rename(staged, applicationCapture.helperPath)
    return { profileDigest: digest }
  } finally {
    await rm(staged, { force: true })
  }
}

if (import.meta.main) {
  console.log(
    JSON.stringify({
      builtOnly: applicationCapture.helperPath,
      ...(await buildApplicationCapture()),
    }),
  )
}
