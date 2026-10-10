/** Build the local-only helper. Never starts capture or installs developer tools. */
import { rename, rm } from "node:fs/promises"
import { join } from "node:path"

export const nativeHelperPath = join(
  import.meta.dir,
  "../audio/native/music-audio-helper",
)
const nativeDirectory = join(import.meta.dir, "../audio/native")
const compiler =
  "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"
const sdk =
  "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"

async function command(args: string[]): Promise<void> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const deadline = setTimeout(() => child.kill("SIGKILL"), 120_000)
  try {
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exit !== 0)
      throw new Error(`${args[0]} exited ${exit}: ${error || output}`)
  } finally {
    clearTimeout(deadline)
  }
}

export async function buildNativeAudioHelper(): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error("The local native helper requires macOS and Xcode")
  const staged = `${nativeHelperPath}.staging.${process.pid}`
  try {
    await command([
      compiler,
      "-sdk",
      sdk,
      "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.2`,
      "-swift-version",
      "5",
      "-warnings-as-errors",
      "-O",
      join(nativeDirectory, "MusicAudioHelper.swift"),
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      join(nativeDirectory, "Info.plist"),
      "-o",
      staged,
    ])
    await command([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      "dev.naxo.music.audio-helper",
      staged,
    ])
    await command([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "-R",
      '=identifier "dev.naxo.music.audio-helper"',
      staged,
    ])
    // Publish a verified inode. Do not rewrite a helper that might be running.
    await rename(staged, nativeHelperPath)
  } finally {
    await rm(staged, { force: true })
  }
}

if (import.meta.main) {
  await buildNativeAudioHelper()
  console.log(`Built local-only helper: ${nativeHelperPath}`)
}
