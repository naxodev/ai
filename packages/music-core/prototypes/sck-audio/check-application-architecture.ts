/** Read-only disk-signature regression. No running metadata, discovery, or capture. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { command, compiler, sdk } from "./build.ts"

const output = join(import.meta.dir, "dist")
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(output, "architecture-check-"))
const before = (source: string, marker: string) => {
  const offset = source.indexOf(marker)
  if (offset < 0 || source.indexOf(marker, offset + marker.length) >= 0)
    throw new Error("Native composition boundary changed: " + marker)
  return source.slice(0, offset)
}
try {
  const source =
    before(
      await readFile(
        join(import.meta.dir, "../../audio/native/MusicAudioHelper.swift"),
        "utf8",
      ),
      "private final class Cleanup",
    ) +
    before(
      await readFile(
        join(import.meta.dir, "ApplicationDiscovery.swift"),
        "utf8",
      ),
      "private func verifySingleWitness(",
    ) +
    '\nprivate let applicationProfilePath = ""\nprivate let applicationProfileDigest = ""\n'
  if (
    /SCShareableContent\.|SCStream\(|AudioHardwareCreateProcessTap|AudioDeviceStart/.test(
      source,
    )
  )
    throw new Error("Protected work crossed the disk-signature check boundary")
  const file = join(directory, "main.swift")
  const executable = join(directory, "architecture-check")
  await writeFile(
    file,
    source +
      `
do {
    for location in [ApplicationLocation.kaset, .safari] {
        var expected: SecStaticCode?
        let attributes = [kSecCodeAttributeArchitecture as String: appArchitecture] as CFDictionary
        guard SecStaticCodeCreateWithPathAndAttributes(URL(fileURLWithPath: location.bundle) as CFURL,
            [], attributes, &expected) == errSecSuccess, let expected else {
            throw HelperError(reason: "native-architecture-unavailable")
        }
        let actual = try diskCode(location)
        try validateDiskCode(actual, nil)
        try validateDiskCode(expected, nil)
        guard try signingFields(actual).hash == signingFields(expected).hash else {
            throw HelperError(reason: "native-architecture-mismatch")
        }
        print(location.identifier + ": native signing architecture passed")
    }
} catch {
    diagnostic((error as? HelperError)?.reason ?? "setup")
    exit(1)
}
`,
  )
  await command([
    compiler,
    "-sdk",
    sdk,
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos15.2`,
    "-module-cache-path",
    join(output, "module-cache"),
    "-swift-version",
    "5",
    "-warnings-as-errors",
    file,
    "-o",
    executable,
  ])
  console.log((await command([executable])).trim())
} finally {
  await rm(directory, { recursive: true, force: true })
}
