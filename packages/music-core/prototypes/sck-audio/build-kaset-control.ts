/** Offline file conversion only. Never plays, uploads, opens an app, or starts capture. */
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createKasetControlWave,
  inspectKasetControlWave,
  inspectKasetControlFlac,
  assertKasetControlRoundTrip,
  kasetControlAsset,
} from "./kaset-control-asset.ts"

const ffmpeg = "/opt/homebrew/bin/ffmpeg"
const decoder = "/usr/bin/afconvert"
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")
async function readAudioFile(path: string) {
  const maximum = 16 * 1024 * 1024
  const file = Bun.file(path)
  if (file.size > maximum)
    throw new Error("Offline audio file exceeds its bound")
  const bytes = await file.slice(0, maximum + 1).bytes()
  if (bytes.length > maximum)
    throw new Error("Offline audio file grew beyond its bound")
  return bytes
}
function command([executable, ...args]: readonly [string, ...string[]]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 8192,
        killSignal: "SIGKILL",
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `Offline conversion failed (${error.code ?? "unknown"}): ${stderr.slice(0, 4096)}`,
            ),
          )
        else resolve(stdout)
      },
    )
  })
}

export async function buildKasetControl() {
  if (process.platform !== "darwin")
    throw new Error("Independent decoding requires macOS afconvert")
  const directory = join(import.meta.dir, "dist/controlled-kaset-source")
  // An existing asset may already be approved. Never replace it implicitly.
  await mkdir(join(import.meta.dir, "dist"), { recursive: true })
  await mkdir(directory)
  const temporary = await mkdtemp(join(directory, "work-"))
  try {
    const original = createKasetControlWave()
    const measurements = inspectKasetControlWave(original)
    const source = join(temporary, "source.wav")
    const decoded = join(temporary, "decoded.wav")
    const output = join(directory, kasetControlAsset.filename)
    await writeFile(source, original, { flag: "wx" })
    await command([
      ffmpeg,
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-n",
      "-protocol_whitelist",
      "file,pipe",
      "-f",
      "wav",
      "-i",
      source,
      "-map_metadata",
      "-1",
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      "-c:a",
      "flac",
      "-compression_level",
      "8",
      "-sample_fmt",
      "s32",
      "-bits_per_raw_sample",
      "24",
      "-metadata",
      "title=" + kasetControlAsset.title,
      "-f",
      "flac",
      output,
    ])
    const flac = await readAudioFile(output)
    const streamInfo = inspectKasetControlFlac(flac, original)
    await command([decoder, output, "-f", "WAVE", "-d", "LEI24", decoded])
    const decodedWave = await readAudioFile(decoded)
    assertKasetControlRoundTrip(original, decodedWave)
    const decodedMeasurements = inspectKasetControlWave(decodedWave)
    const version = (await command([ffmpeg, "-version"])).split("\n")[0]
    if (digest(await readAudioFile(output)) !== digest(flac))
      throw new Error("Encoded asset changed during independent decoding")
    const manifest = {
      preparedAt: new Date().toISOString(),
      source: "locally synthesized diagnostic tone",
      ...kasetControlAsset,
      fileSha256: digest(flac),
      sourceWaveSha256: digest(original),
      decodedWaveSha256: digest(decodedWave),
      encoder: { version, executableSha256: digest(await readFile(ffmpeg)) },
      independentDecoder: {
        name: "macOS afconvert",
        executableSha256: digest(await readFile(decoder)),
      },
      streamInfo,
      measurements,
      decodedMeasurements,
      losslessRoundTrip: "exact-pcm-match",
      uploaded: false,
      playbackStarted: false,
      captureStarted: false,
      approvedLiveAttempts: 0,
      interpretation:
        "This verifies the local file only. Upload acceptance, installed Kaset playback, streamed waveform, witness identity, independent references, and isolation remain unverified.",
    }
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx" },
    )
    return {
      directory,
      file: output,
      fileSha256: manifest.fileSha256,
      measurements: decodedMeasurements,
      losslessRoundTrip: manifest.losslessRoundTrip,
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
if (import.meta.main) {
  if (process.argv.length !== 2)
    throw new Error("This fixed offline preparation accepts no arguments")
  console.log(JSON.stringify(await buildKasetControl()))
}
