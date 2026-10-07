import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { crc32, deflateSync } from "node:zlib"
import { run, type CommandResult } from "../run.ts"
import { createSystemMediaAdapter } from "../system-media.ts"

const identity = {
  id: "large-cover",
  name: "Song",
  artists: "Artist",
  album: "Album",
  duration_ms: 180_000,
}

function nativePayload(bytes: Uint8Array) {
  return JSON.stringify({
    contentItemIdentifier: identity.id,
    title: identity.name,
    artist: identity.artists,
    album: identity.album,
    duration: 180,
    artworkData: Buffer.from(bytes).toString("base64"),
  })
}

function pngChunk(type: string, bytes: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type), bytes])
  const chunk = Buffer.alloc(bytes.length + 12)
  chunk.writeUInt32BE(bytes.length, 0)
  payload.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(payload), chunk.length - 4)
  return chunk
}

function oversizedPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  // Grayscale scanlines compress well. Metadata pushes the encoded image over
  // the wire budget without changing its decoded pixel cost.
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from(`Padding\0${"x".repeat(768 * 1024)}`)),
    pngChunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function inspectedArtwork(inspected: CommandResult) {
  const commands: string[][] = []
  const backend = createSystemMediaAdapter({
    detectBackend: () => "media-control",
    hasNowPlayingCli: () => false,
    run: async (command) => {
      commands.push(command)
      if (command[0] === "media-control")
        return { ok: true, out: nativePayload(new Uint8Array(64)) }
      if (command[1] === "-g") return inspected
      const output = command.at(-1)
      if (command[1] !== "-Z" || !output)
        throw new Error("unexpected artwork command")
      await writeFile(output, new Uint8Array([1, 2, 3]))
      return { ok: true, out: "" }
    },
  })
  return { backend, commands }
}

test.each([
  "pixelWidth: 4097\npixelHeight: 1",
  "pixelWidth: 1\npixelHeight: 4097",
  "pixelWidth: 4096\npixelHeight: 2930",
  "pixelWidth: 0\npixelHeight: 640",
  "pixelWidth: -1\npixelHeight: 640",
  "pixelWidth: 640\npixelHeight: 0",
  "pixelWidth: 640.5\npixelHeight: 640",
  "pixelWidth: 640\npixelHeight: 640.5",
  "pixelWidth: NaN\npixelHeight: 640",
  "pixelWidth: 640",
])("rejects unsafe or unknown dimensions without resizing: %s", async (out) => {
  const { backend, commands } = inspectedArtwork({ ok: true, out })
  await expect(backend.nativeArtwork?.(identity, 3)).resolves.toEqual({
    type: "too-large",
  })
  expect(commands.some((command) => command[1] === "-g")).toBeTrue()
  expect(commands.some((command) => command[1] === "-Z")).toBeFalse()
})

test.each([
  { ok: false as const, err: "inspection failed", timed_out: false },
  { ok: false as const, err: "inspection timed out", timed_out: true },
])(
  "never resizes after an unsuccessful dimension inspection: %j",
  async (result) => {
    const { backend, commands } = inspectedArtwork(result)
    await expect(backend.nativeArtwork?.(identity, 3)).resolves.toEqual({
      type: "too-large",
    })
    expect(commands.some((command) => command[1] === "-Z")).toBeFalse()
  },
)

test.each([
  [1, 1],
  [4096, 1],
  [1, 4096],
  [4000, 3000],
])(
  "still shrinks byte-large artwork within the dimension limits: %ix%i",
  async (width, height) => {
    const { backend, commands } = inspectedArtwork({
      ok: true,
      out: `pixelWidth: ${width}\npixelHeight: ${height}`,
    })
    await expect(backend.nativeArtwork?.(identity, 3)).resolves.toEqual({
      type: "available",
      base64: "AQID",
    })
    expect(commands[1]?.slice(0, 5)).toEqual([
      "sips",
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
    ])
    expect(commands[2]?.slice(0, 3)).toEqual(["sips", "-Z", "640"])
  },
)

test.skipIf(process.platform !== "darwin")(
  "rejects oversized PNG dimensions before native downscaling can bypass the host limits",
  async () => {
    const bytes = oversizedPng(8192, 8192)
    expect(bytes.byteLength).toBeGreaterThan(512 * 1024)
    const commands: string[][] = []
    const backend = createSystemMediaAdapter({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command, timeoutMs, maxBufferBytes) => {
        commands.push(command)
        return command[0] === "media-control"
          ? { ok: true, out: nativePayload(bytes) }
          : run(command, timeoutMs, maxBufferBytes)
      },
    })

    await expect(
      backend.nativeArtwork?.(identity, 512 * 1024),
    ).resolves.toEqual({
      type: "too-large",
    })
    expect(commands.some((command) => command[1] === "-Z")).toBeFalse()
  },
)

test.skipIf(process.platform !== "darwin")(
  "real native conversion still loads byte-large covers with safe dimensions",
  async () => {
    const bytes = oversizedPng(640, 640)
    expect(bytes.byteLength).toBeGreaterThan(512 * 1024)
    const backend = createSystemMediaAdapter({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command, timeoutMs, maxBufferBytes) =>
        command[0] === "media-control"
          ? { ok: true, out: nativePayload(bytes) }
          : run(command, timeoutMs, maxBufferBytes),
    })
    const result = await backend.nativeArtwork?.(identity, 512 * 1024)
    expect(result?.type).toBe("available")
    if (result?.type !== "available")
      throw new Error("expected converted cover")
    const converted = Buffer.from(result.base64, "base64")
    expect(converted.byteLength).toBeGreaterThan(0)
    expect(converted.byteLength).toBeLessThanOrEqual(512 * 1024)
    expect(converted.subarray(0, 3).toString("hex")).toBe("ffd8ff")
  },
)
