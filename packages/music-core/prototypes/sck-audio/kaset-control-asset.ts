/** Generated source audio only. This module opens no device, process, or network connection. */
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

export const kasetControlAsset = Object.freeze({
  frequency: 997,
  peak: 0.1,
  sampleRate: 48000,
  channels: 2,
  bitsPerSample: 24,
  seconds: 30,
  windowFrames: 4800,
  filename: "kaset-997hz-control-30s.flac",
  title: "Kaset 997 Hz control",
})
const frames = kasetControlAsset.sampleRate * kasetControlAsset.seconds
const bytesPerFrame = 6
const scale = 2 ** 23
const maximumFileBytes = 16 * 1024 * 1024

export function createKasetControlWave() {
  const wave = Buffer.alloc(44 + frames * bytesPerFrame)
  wave.write("RIFF", 0)
  wave.writeUInt32LE(wave.length - 8, 4)
  wave.write("WAVEfmt ", 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(2, 22)
  wave.writeUInt32LE(48000, 24)
  wave.writeUInt32LE(48000 * bytesPerFrame, 28)
  wave.writeUInt16LE(bytesPerFrame, 32)
  wave.writeUInt16LE(24, 34)
  wave.write("data", 36)
  wave.writeUInt32LE(frames * bytesPerFrame, 40)
  const period = Buffer.alloc(48000 * bytesPerFrame)
  for (let frame = 0; frame < 48000; frame++) {
    const value = Math.round(
      scale *
        kasetControlAsset.peak *
        Math.sin((2 * Math.PI * kasetControlAsset.frequency * frame) / 48000),
    )
    period.writeIntLE(value, frame * bytesPerFrame, 3)
    period.writeIntLE(value, frame * bytesPerFrame + 3, 3)
  }
  for (let second = 0; second < kasetControlAsset.seconds; second++)
    period.copy(wave, 44 + second * period.length)
  return wave
}

/** Accept the canonical source WAV and the independent decoder's PCM/extensible WAV. */
export function readKasetControlPcm(input: Uint8Array) {
  const wave = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (
    wave.length < 44 ||
    wave.length > maximumFileBytes ||
    wave.toString("ascii", 0, 4) !== "RIFF" ||
    wave.toString("ascii", 8, 12) !== "WAVE" ||
    wave.readUInt32LE(4) !== wave.length - 8
  )
    throw new Error("Invalid control WAV container")
  let format: Buffer | undefined
  let pcm: Buffer | undefined
  let offset = 12
  let chunks = 0
  while (offset + 8 <= wave.length && ++chunks <= 32) {
    const name = wave.toString("ascii", offset, offset + 4)
    const size = wave.readUInt32LE(offset + 4)
    const end = offset + 8 + size
    if (end > wave.length) throw new Error("Truncated control WAV chunk")
    if (name === "fmt ") {
      if (format) throw new Error("Duplicate control WAV format")
      format = wave.subarray(offset + 8, end)
    } else if (name === "data") {
      if (pcm) throw new Error("Duplicate control WAV data")
      pcm = wave.subarray(offset + 8, end)
    }
    offset = end + (size % 2)
  }
  if (offset !== wave.length || !format || format.length < 16 || !pcm)
    throw new Error("Incomplete control WAV")
  const tag = format.readUInt16LE(0)
  const extensiblePcm =
    tag === 0xfffe &&
    format.length === 40 &&
    format.readUInt16LE(16) === 22 &&
    format.readUInt16LE(18) === 24 &&
    format.readUInt32LE(20) === 3 &&
    format
      .subarray(24)
      .equals(Buffer.from("0100000000001000800000aa00389b71", "hex"))
  if (
    !(tag === 1 || extensiblePcm) ||
    format.readUInt16LE(2) !== 2 ||
    format.readUInt32LE(4) !== 48000 ||
    format.readUInt32LE(8) !== 48000 * bytesPerFrame ||
    format.readUInt16LE(12) !== bytesPerFrame ||
    format.readUInt16LE(14) !== 24
  )
    throw new Error("Unsupported control PCM format")
  if (pcm.length !== frames * bytesPerFrame)
    throw new Error("Control duration changed")
  return pcm
}

export function assertKasetControlRoundTrip(
  original: Uint8Array,
  decoded: Uint8Array,
) {
  if (!readKasetControlPcm(original).equals(readKasetControlPcm(decoded)))
    throw new Error("Lossless decoded PCM differs from source")
}

/** STREAMINFO and its PCM checksum are additional checks, not a substitute for decoding. */
export function inspectKasetControlFlac(
  input: Uint8Array,
  original: Uint8Array,
) {
  const flac = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (
    flac.length < 43 ||
    flac.length > maximumFileBytes ||
    flac.toString("ascii", 0, 4) !== "fLaC" ||
    (flac[4]! & 0x7f) !== 0 ||
    flac.readUIntBE(5, 3) !== 34
  )
    throw new Error("Invalid FLAC STREAMINFO")
  const packed = flac.readBigUInt64BE(18)
  const sampleRate = Number(packed >> 44n)
  const channels = Number((packed >> 41n) & 7n) + 1
  const bitsPerSample = Number((packed >> 36n) & 31n) + 1
  const sampleFrames = Number(packed & ((1n << 36n) - 1n))
  const pcmMd5 = createHash("md5")
    .update(readKasetControlPcm(original))
    .digest("hex")
  if (
    sampleRate !== 48000 ||
    channels !== 2 ||
    bitsPerSample !== 24 ||
    sampleFrames !== frames ||
    flac.subarray(26, 42).toString("hex") !== pcmMd5
  )
    throw new Error("FLAC format or source checksum changed")
  let offset = 4
  let blocks = 0
  let last = false
  let titleSeen = false
  let vendor = ""
  const metadataBlockTypes: number[] = []
  const text = new TextDecoder("utf-8", { fatal: true })
  while (!last && ++blocks <= 32) {
    if (offset + 4 > flac.length) throw new Error("Truncated FLAC metadata")
    last = (flac[offset]! & 0x80) !== 0
    const type = flac[offset]! & 0x7f
    const size = flac.readUIntBE(offset + 1, 3)
    const end = offset + 4 + size
    if (end > flac.length || end > 65536)
      throw new Error("Oversized FLAC metadata")
    const block = flac.subarray(offset + 4, end)
    if (type === 0) {
      if (offset !== 4) throw new Error("Duplicate FLAC STREAMINFO")
    } else if (type === 1) {
      if (block.some((value) => value !== 0))
        throw new Error("Nonzero FLAC padding")
    } else if (type === 4) {
      let cursor = 0
      const number = () => {
        if (cursor + 4 > block.length)
          throw new Error("Truncated FLAC comment length")
        const value = block.readUInt32LE(cursor)
        cursor += 4
        return value
      }
      const field = () => {
        const length = number()
        if (length > 4096 || cursor + length > block.length)
          throw new Error("Oversized FLAC comment")
        const value = text.decode(block.subarray(cursor, cursor + length))
        cursor += length
        return value
      }
      vendor = field()
      if (vendor !== "ffmpeg")
        throw new Error("Unexpected FLAC encoder metadata")
      if (
        number() !== 1 ||
        titleSeen ||
        field() !== "title=" + kasetControlAsset.title ||
        cursor !== block.length
      )
        throw new Error("Unexpected FLAC title or additional metadata")
      titleSeen = true
    } else throw new Error("Unreviewed FLAC metadata block")
    metadataBlockTypes.push(type)
    offset = end
  }
  if (!last || !titleSeen || offset >= flac.length)
    throw new Error("Incomplete FLAC file")
  return {
    sampleRate,
    channels,
    bitsPerSample,
    sampleFrames,
    pcmMd5,
    vendor,
    metadataBlockTypes,
    title: kasetControlAsset.title,
  }
}

export function inspectKasetControlWave(input: Uint8Array) {
  const pcm = readKasetControlPcm(input)
  const count = kasetControlAsset.windowFrames
  const weights = Float64Array.from(
    { length: count },
    (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / count),
  )
  const weightPower = weights.reduce((sum, value) => sum + value * value, 0)
  const bins = [
    ...Array.from({ length: 6 }, (_, index) => index + 97),
    ...Array.from({ length: 6 }, (_, index) => index + 209),
  ]
  const bases = bins.map((bin) => ({
    cosine: Float64Array.from({ length: count }, (_, index) =>
      Math.cos((2 * Math.PI * bin * index) / count),
    ),
    sine: Float64Array.from({ length: count }, (_, index) =>
      Math.sin((2 * Math.PI * bin * index) / count),
    ),
  }))
  const window = new Float64Array(count)
  let peak = 0
  let totalPower = 0
  let risingCrossings = 0
  let previous = 0
  let markerMin = Infinity
  let markerMax = 0
  let purityMin = Infinity
  let otherMarkerMax = 0
  for (let start = 0; start < frames; start += count) {
    let weightedPower = 0
    for (let index = 0; index < count; index++) {
      const offset = (start + index) * bytesPerFrame
      const left = pcm.readIntLE(offset, 3)
      const right = pcm.readIntLE(offset + 3, 3)
      if (left !== right) throw new Error("Control stereo channels differ")
      const sample = left / scale
      peak = Math.max(peak, Math.abs(sample))
      if (previous <= 0 && sample > 0) risingCrossings++
      previous = sample
      totalPower += sample * sample
      window[index] = sample * weights[index]!
      weightedPower += window[index]! ** 2
    }
    const powers = bases.map(({ cosine, sine }) => {
      let real = 0
      let imaginary = 0
      for (let index = 0; index < count; index++) {
        real += window[index]! * cosine[index]!
        imaginary += window[index]! * sine[index]!
      }
      return (2 * (real * real + imaginary * imaginary)) / (count * weightPower)
    })
    const marker = powers.slice(0, 6).reduce((sum, value) => sum + value, 0)
    const otherMarker = powers.slice(6).reduce((sum, value) => sum + value, 0)
    const purity = marker / (weightedPower / weightPower)
    if (
      !Number.isFinite(purity) ||
      marker < 1e-4 ||
      purity < 0.95 ||
      otherMarker > 1e-8
    )
      throw new Error(
        "Control marker power, purity, or other-band limit failed",
      )
    markerMin = Math.min(markerMin, marker)
    markerMax = Math.max(markerMax, marker)
    purityMin = Math.min(purityMin, purity)
    otherMarkerMax = Math.max(otherMarkerMax, otherMarker)
  }
  const frequencyHz = risingCrossings / kasetControlAsset.seconds
  if (frequencyHz !== 997 || Math.abs(peak - 0.1) > 1 / scale)
    throw new Error("Control frequency or peak changed")
  return {
    frames,
    windows: frames / count,
    frequencyHz,
    peak,
    meanPower: totalPower / frames,
    markerMin,
    markerMax,
    purityMin,
    otherMarkerMax,
    channelDifferenceMax: 0,
  }
}
