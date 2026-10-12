import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createKasetControlWave,
  inspectKasetControlWave,
  assertKasetControlRoundTrip,
  inspectKasetControlFlac,
} from "./kaset-control-asset.ts"

function flacMetadata(
  comments: string[],
  extra?: { type: number; bytes: Buffer },
) {
  const info = Buffer.alloc(34)
  info.writeBigUInt64BE(
    (48000n << 44n) | (1n << 41n) | (23n << 36n) | 1440000n,
    10,
  )
  createHash("md5")
    .update(createKasetControlWave().subarray(44))
    .digest()
    .copy(info, 18)
  const vendor = Buffer.from("ffmpeg")
  const fields = comments.map((value) => Buffer.from(value))
  const tags = Buffer.alloc(
    4 +
      vendor.length +
      4 +
      fields.reduce((sum, value) => sum + 4 + value.length, 0),
  )
  tags.writeUInt32LE(vendor.length, 0)
  vendor.copy(tags, 4)
  tags.writeUInt32LE(fields.length, 4 + vendor.length)
  let offset = 8 + vendor.length
  for (const value of fields) {
    tags.writeUInt32LE(value.length, offset)
    value.copy(tags, offset + 4)
    offset += 4 + value.length
  }
  const blocks = [
    { type: 0, bytes: info },
    { type: 4, bytes: tags },
    ...(extra ? [extra] : []),
  ]
  return Buffer.concat([
    Buffer.from("fLaC"),
    ...blocks.flatMap((block, index) => {
      const header = Buffer.alloc(4)
      header[0] = block.type | (index === blocks.length - 1 ? 0x80 : 0)
      header.writeUIntBE(block.bytes.length, 1, 3)
      return [header, block.bytes]
    }),
    Buffer.from([0]),
  ]) // Metadata fixture only; the builder also requires independent full decoding.
}

test("the upload file can contain only the reviewed generic title and zero padding", () => {
  const source = createKasetControlWave()
  const title = "title=Kaset 997 Hz control"
  expect(inspectKasetControlFlac(flacMetadata([title]), source).title).toBe(
    "Kaset 997 Hz control",
  )
  expect(() =>
    inspectKasetControlFlac(
      flacMetadata([title, "comment=unreviewed information"]),
      source,
    ),
  ).toThrow("additional metadata")
  expect(() =>
    inspectKasetControlFlac(
      flacMetadata([title], { type: 6, bytes: Buffer.from([0]) }),
      source,
    ),
  ).toThrow("Unreviewed FLAC metadata block")
  expect(() =>
    inspectKasetControlFlac(
      flacMetadata([title], { type: 1, bytes: Buffer.from([1]) }),
      source,
    ),
  ).toThrow("Nonzero FLAC padding")
})

test("compressed format declarations and the source checksum must agree before decoding is accepted", () => {
  const source = createKasetControlWave()
  const changed = flacMetadata(["title=Kaset 997 Hz control"])
  changed[26] = changed[26]! ^ 1
  expect(() => inspectKasetControlFlac(changed, source)).toThrow(
    "source checksum",
  )
  const short = flacMetadata(["title=Kaset 997 Hz control"])
  short.writeBigUInt64BE(short.readBigUInt64BE(18) ^ 1n, 18)
  expect(() => inspectKasetControlFlac(short, source)).toThrow(
    "source checksum",
  )
})

function signal(frequency: number, peak = 0.1, safariPeak = 0) {
  const wave = createKasetControlWave()
  for (let frame = 0; frame < 48000 * 30; frame++) {
    const phase = (2 * Math.PI * (frame % 48000)) / 48000
    const value = Math.round(
      2 ** 23 *
        (peak * Math.sin(frequency * phase) +
          safariPeak * Math.sin(2113 * phase)),
    )
    wave.writeIntLE(value, 44 + frame * 6, 3)
    wave.writeIntLE(value, 47 + frame * 6, 3)
  }
  return wave
}
test("the local control supplies every declared window at the exact Kaset marker frequency", () => {
  const result = inspectKasetControlWave(createKasetControlWave())
  expect(result.frames).toBe(1440000)
  expect(result.windows).toBe(300)
  expect(result.frequencyHz).toBe(997)
  expect(result.channelDifferenceMax).toBe(0)
  expect(result.markerMin).toBeGreaterThanOrEqual(1e-4)
  expect(result.purityMin).toBeGreaterThanOrEqual(0.95)
  expect(result.otherMarkerMax).toBeLessThanOrEqual(1e-8)
})
test("a different tone inside the broad marker band cannot impersonate the exact 997 Hz asset", () => {
  expect(() => inspectKasetControlWave(signal(1000))).toThrow(
    "frequency or peak",
  )
})
test("low Safari-band contamination cannot pass just because the Kaset marker remains pure and correctly leveled", () => {
  expect(() => inspectKasetControlWave(signal(997, 0.098, 0.002))).toThrow(
    "other-band",
  )
})
test("opposite stereo channels cannot pass the required identical-channel control", () => {
  const wave = createKasetControlWave()
  for (let frame = 0; frame < 48000 * 30; frame++)
    wave.writeIntLE(-wave.readIntLE(44 + frame * 6, 3), 47 + frame * 6, 3)
  expect(() => inspectKasetControlWave(wave)).toThrow("stereo channels differ")
})
test("a silent final window cannot be hidden by positive aggregate energy", () => {
  const wave = createKasetControlWave()
  wave.fill(0, wave.length - 4800 * 6)
  expect(() => inspectKasetControlWave(wave)).toThrow("marker power")
})
test("a changed rate or shortened container cannot claim the declared playback frequency and duration", () => {
  const rate = createKasetControlWave()
  rate.writeUInt32LE(44100, 24)
  rate.writeUInt32LE(44100 * 6, 28)
  expect(() => inspectKasetControlWave(rate)).toThrow("PCM format")
  const shorter = createKasetControlWave().subarray(0, 44 + (1440000 - 1) * 6)
  shorter.writeUInt32LE(shorter.length - 8, 4)
  shorter.writeUInt32LE(shorter.length - 44, 40)
  expect(() => inspectKasetControlWave(shorter)).toThrow("duration changed")
})
test("an independently decoded sample change fails lossless identity even when the spectral control still passes", () => {
  const original = createKasetControlWave()
  const decoded = Buffer.from(original)
  decoded.writeIntLE(decoded.readIntLE(50, 3) + 1, 50, 3)
  decoded.writeIntLE(decoded.readIntLE(53, 3) + 1, 53, 3)
  expect(inspectKasetControlWave(decoded).frequencyHz).toBe(997)
  expect(() => assertKasetControlRoundTrip(original, decoded)).toThrow(
    "differs from source",
  )
})
test("importing preparation cannot convert or write, and CLI arguments fail before filesystem work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaset-control-import-"))
  const preload = join(directory, "preload.ts")
  const entry = join(directory, "entry.ts")
  const builder = join(import.meta.dir, "build-kaset-control.ts")
  try {
    await writeFile(
      preload,
      `import {mock} from "bun:test";
const forbidden = () => { throw new Error("Unexpected preparation side effect") };
mock.module("node:fs/promises", () => ({mkdir:forbidden,mkdtemp:forbidden,readFile:forbidden,rm:forbidden,writeFile:forbidden}));
mock.module("node:child_process", () => ({execFile:forbidden}));\n`,
    )
    await writeFile(
      entry,
      `import ${JSON.stringify(builder)}; console.log("import-safe");\n`,
    )
    for (const [args, expected, message] of [
      [[entry], 0, "import-safe"],
      [[builder, "--upload"], 1, "accepts no arguments"],
    ] as const) {
      const child = Bun.spawn(
        [process.execPath, "--preload", preload, ...args],
        { stdout: "pipe", stderr: "pipe" },
      )
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(exit).toBe(expected)
        expect(stdout + stderr).toContain(message)
      } finally {
        clearTimeout(timer)
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
