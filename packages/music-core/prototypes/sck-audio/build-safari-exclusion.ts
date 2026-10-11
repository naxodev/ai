/** Compile/sign only. Metadata preparation validates disk code, never discovery or capture. */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { command, compiler, sdk } from "./build.ts"
import {
  ApplicationProfile,
  applicationProfileDigest,
} from "./application-profile.ts"
import { applicationCapture } from "./application-capture.ts"
import { safariExclusion } from "./safari-exclusion.ts"

const SafariProfile = Schema.Struct({
  ...ApplicationProfile.fields,
  bundleIdentifier: Schema.Literal("com.apple.Safari"),
  bundlePath: Schema.Literal(
    "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app",
  ),
  executablePath: Schema.Literal(
    "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari",
  ),
  teamIdentifier: Schema.Literal(""),
  requirement: Schema.Literal('identifier "com.apple.Safari" and anchor apple'),
})
const before = (source: string, marker: string) => {
  const offset = source.indexOf(marker)
  if (offset < 0 || source.indexOf(marker, offset + marker.length) >= 0)
    throw new Error("Native composition boundary changed: " + marker)
  return source.slice(0, offset)
}
export async function buildSafariExclusion() {
  if (process.platform !== "darwin")
    throw new Error("Safari exclusion requires macOS")
  const output = join(import.meta.dir, "dist")
  if (
    await Bun.file(
      join(import.meta.dir, safariExclusion.evidenceDirectory, "attempt.json"),
    ).exists()
  )
    throw new Error(
      "Exclusion was attempted; preserve reviewed artifacts before another preparation",
    )
  const kasetBytes = await readFile(
    join(
      output,
      "application-discovery-evidence/kaset-application-profile.json",
    ),
  )
  if (
    kasetBytes.byteLength > 16384 ||
    applicationProfileDigest(kasetBytes) !==
      applicationCapture.discoveryProfileDigest
  )
    throw new Error(
      "The proven Kaset profile changed; review instead of refreshing it",
    )
  Schema.decodeUnknownSync(ApplicationProfile)(
    JSON.parse(kasetBytes.toString("utf8")),
  )
  const original = await readFile(
    join(import.meta.dir, "../../audio/native/MusicAudioHelper.swift"),
    "utf8",
  )
  const primitives = before(original, "private final class Cleanup")
  if (/AudioHardwareCreateProcessTap|AudioDeviceStart/.test(primitives))
    throw new Error("Process tap crossed the exclusion boundary")
  const read = (name: string) => readFile(join(import.meta.dir, name), "utf8")
  const sck = await read("SckCapture.swift")
  const fixtureStart = sck.indexOf("private func pcmFixture(")
  if (fixtureStart < 0) throw new Error("PCM fixture boundary changed")
  const shared =
    primitives +
    (await read("SckPCM.swift")) +
    before(sck, "// Exact process match only.") +
    before(sck.slice(fixtureStart), "private func syntheticSck(") +
    before(
      await read("ApplicationDiscovery.swift"),
      "private func applicationMain() throws {",
    ) +
    before(
      await read("ApplicationCapture.swift"),
      "private func applicationCaptureMain() throws {",
    ) +
    (await read("ExclusionAnalysis.swift")) +
    (await read("ExclusionFixture.swift"))
  const entry = await read("SafariExclusion.swift")
  const sourcePath = join(output, "safari-exclusion-main.swift")
  const bootstrap = join(output, `safari-profile-preparation.${process.pid}`)
  const staged = `${safariExclusion.helperPath}.staging.${process.pid}`
  const constants = (digest: string) =>
    `private let applicationProfilePath = ${JSON.stringify(safariExclusion.profilePath)}\nprivate let applicationProfileDigest = ${JSON.stringify(applicationCapture.discoveryProfileDigest)}\nprivate let safariProfilePath = ${JSON.stringify(safariExclusion.safariProfilePath)}\nprivate let safariProfileDigest = ${JSON.stringify(digest)}\n`
  const compile = (destination: string, flags: string[] = []) =>
    command([
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
      ...flags,
      sourcePath,
      "-o",
      destination,
    ])
  await mkdir(output, { recursive: true })
  try {
    await writeFile(sourcePath, shared + constants("") + entry)
    await compile(bootstrap, ["-D", "PROFILE_PREPARATION"])
    const safariBytes = await command([bootstrap, "--prepare-safari-profile"])
    if (Buffer.byteLength(safariBytes) > 16384)
      throw new Error("Safari profile exceeded its bound")
    const profile = Schema.decodeUnknownSync(SafariProfile)(
      JSON.parse(safariBytes),
    )
    if (
      profile.architecture !== (process.arch === "arm64" ? "arm64" : "x86_64")
    )
      throw new Error("Safari profile architecture differs from the helper")
    const digest = applicationProfileDigest(Buffer.from(safariBytes))
    await writeFile(safariExclusion.profilePath, kasetBytes, { mode: 0o600 })
    await writeFile(safariExclusion.safariProfilePath, safariBytes, {
      mode: 0o600,
    })
    await writeFile(sourcePath, shared + constants(digest) + entry)
    await compile(staged)
    await command([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      safariExclusion.helperIdentifier,
      staged,
    ])
    await command([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "-R",
      `=identifier "${safariExclusion.helperIdentifier}"`,
      staged,
    ])
    await rename(staged, safariExclusion.helperPath)
    return {
      safariProfileDigest: digest,
      kasetProfileDigest: applicationCapture.discoveryProfileDigest,
    }
  } finally {
    await rm(bootstrap, { force: true })
    await rm(staged, { force: true })
  }
}
if (import.meta.main)
  console.log(
    JSON.stringify({
      builtOnly: safariExclusion.helperPath,
      ...(await buildSafariExclusion()),
    }),
  )
