/** Build only. Preparation validates disk code and never inspects shareable content. */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { applicationDiscovery } from "./application-discovery.ts"
import {
  ApplicationProfile,
  applicationProfileDigest,
} from "./application-profile.ts"
import { command, compiler, sdk } from "./build.ts"

export async function buildApplicationDiscovery() {
  if (process.platform !== "darwin")
    throw new Error("Application discovery requires macOS")
  const output = join(import.meta.dir, "dist")
  if (
    await Bun.file(
      join(
        import.meta.dir,
        applicationDiscovery.evidenceDirectory,
        "attempt.json",
      ),
    ).exists()
  )
    throw new Error(
      "Application discovery was attempted; preserve its reviewed artifacts before another preparation",
    )
  await mkdir(output, { recursive: true })
  const original = await readFile(
    join(import.meta.dir, "../../audio/native/MusicAudioHelper.swift"),
    "utf8",
  )
  const marker = "private struct Snapshot {"
  const split = original.indexOf(marker)
  if (split < 0 || original.indexOf(marker, split + marker.length) >= 0)
    throw new Error(
      "Native metadata boundary changed; review application composition",
    )
  // Cut before samples, Analyzer, taps, aggregates, and capture entrypoints.
  const prefix = original.slice(0, split)
  if (/AudioHardwareCreateProcessTap|AudioDeviceStart|SCStream\(/.test(prefix))
    throw new Error("Capture crossed the metadata composition boundary")
  const implementation = await readFile(
    join(import.meta.dir, "ApplicationDiscovery.swift"),
    "utf8",
  )
  const sourcePath = join(output, "application-main.swift")
  const bootstrap = join(
    output,
    `application-profile-preparation.${process.pid}`,
  )
  const staged = `${applicationDiscovery.helperPath}.staging.${process.pid}`
  const constants = (digest: string) =>
    `private let applicationProfilePath = ${JSON.stringify(applicationDiscovery.profilePath)}\nprivate let applicationProfileDigest = ${JSON.stringify(digest)}\n`
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
  try {
    await writeFile(sourcePath, prefix + constants("") + implementation)
    await compile(bootstrap, ["-D", "PROFILE_PREPARATION"])
    const raw = await command([bootstrap, "--prepare-profile"])
    if (Buffer.byteLength(raw) > 16384)
      throw new Error("Application profile exceeded its bound")
    const value: unknown = JSON.parse(raw)
    const profile = Schema.decodeUnknownSync(ApplicationProfile)(value)
    if (
      profile.architecture !== (process.arch === "arm64" ? "arm64" : "x86_64")
    )
      throw new Error(
        "Application profile architecture differs from the helper",
      )
    // Persist the exact validated preparation bytes; the helper pins their digest.
    const digest = applicationProfileDigest(Buffer.from(raw))
    await writeFile(applicationDiscovery.profilePath, raw, { mode: 0o600 })
    await writeFile(sourcePath, prefix + constants(digest) + implementation)
    await compile(staged)
    await command([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      applicationDiscovery.helperIdentifier,
      staged,
    ])
    await command([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "-R",
      `=identifier "${applicationDiscovery.helperIdentifier}"`,
      staged,
    ])
    await rename(staged, applicationDiscovery.helperPath)
    return { profileDigest: digest }
  } finally {
    await rm(bootstrap, { force: true })
    await rm(staged, { force: true })
  }
}

if (import.meta.main) {
  const result = await buildApplicationDiscovery()
  console.log(
    JSON.stringify({ builtOnly: applicationDiscovery.helperPath, ...result }),
  )
}
