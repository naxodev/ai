import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PNG } from "pngjs"
import type { Artwork } from "./types.ts"
import {
  acquireCatalogArtwork,
  MAX_ARTWORK_BYTES,
  selectCatalogResolution,
  type CatalogTarget as TrackIdentity,
  type ArtworkFetcher as Fetcher,
} from "@naxodev/music-core"
export {
  selectCatalogResolution,
  selectCatalogTrack,
  readLimitedResponse,
  downloadCatalogImage,
  type CatalogTrack,
} from "@naxodev/music-core"

const MAX_CONVERTED_PNG_BYTES = 1_000_000
const MAX_IMAGE_DIMENSION = 4_096
const MAX_IMAGE_PIXELS = 12_000_000
const CONVERSION_TIMEOUT_MS = 3_000

export function selectArtworkUrl(
  target: TrackIdentity,
  results: import("@naxodev/music-core").CatalogTrack[],
): string | null {
  return selectCatalogResolution(target, results).artworkUrl
}

export function imageDimensionsAreSafe(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION &&
    width * height <= MAX_IMAGE_PIXELS
  )
}

export async function runCommandWithTimeout(
  command: string[],
  timeoutMs: number,
): Promise<{ code: number; out: string; timed_out: boolean }> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill(9)
  }, timeoutMs)
  try {
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    return { code, out, timed_out: timedOut }
  } finally {
    clearTimeout(timer)
  }
}

function dimensionsFromSips(
  output: string,
): { width: number; height: number } | null {
  const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1])
  const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1])
  return imageDimensionsAreSafe(width, height) ? { width, height } : null
}

async function squarePng(
  bytes: Uint8Array,
  size: number,
): Promise<Uint8Array | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTWORK_BYTES)
    return null
  const dir = await mkdtemp(join(tmpdir(), "opencode-music-art-"))
  const input = join(dir, "input")
  const output = join(dir, "art.png")
  try {
    await Bun.write(input, bytes)
    const inspected = await runCommandWithTimeout(
      ["sips", "-g", "pixelWidth", "-g", "pixelHeight", input],
      CONVERSION_TIMEOUT_MS,
    )
    if (
      inspected.timed_out ||
      inspected.code !== 0 ||
      !dimensionsFromSips(inspected.out)
    ) {
      return null
    }

    const converted = await runCommandWithTimeout(
      [
        "sips",
        "-z",
        String(size),
        String(size),
        "-s",
        "format",
        "png",
        input,
        "--out",
        output,
      ],
      CONVERSION_TIMEOUT_MS,
    )
    if (converted.timed_out || converted.code !== 0) return null
    const file = Bun.file(output)
    if (file.size === 0 || file.size > MAX_CONVERTED_PNG_BYTES) return null
    return new Uint8Array(await file.arrayBuffer())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const hex = (r: number, g: number, b: number) =>
  `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`

function presentation(pngBytes: Uint8Array): Pick<Artwork, "cells" | "accent"> {
  const image = PNG.sync.read(Buffer.from(pngBytes))
  const cells: Artwork["cells"] = []
  let accent = "#7aa2f7"
  let accentScore = -1

  for (let y = 0; y < image.height; y += 2) {
    const row: Artwork["cells"][number] = []
    for (let x = 0; x < image.width; x++) {
      const colors = [y, Math.min(y + 1, image.height - 1)].map((py) => {
        const offset = (py * image.width + x) * 4
        const r = image.data[offset] ?? 0
        const g = image.data[offset + 1] ?? 0
        const b = image.data[offset + 2] ?? 0
        const max = Math.max(r, g, b) / 255
        const min = Math.min(r, g, b) / 255
        const light = (max + min) / 2
        const score = (max - min) * (1 - Math.abs(light - 0.5) * 2)
        if (score > accentScore) {
          accentScore = score
          accent = hex(r, g, b)
        }
        return hex(r, g, b)
      })
      row.push({ upper: colors[0]!, lower: colors[1]! })
    }
    cells.push(row)
  }
  return { cells, accent }
}

export type ArtworkResolution = {
  artwork: Artwork | null
  duration_ms: number
}

export async function resolveArtworkDetails(
  id: string,
  target: TrackIdentity,
  nativeBase64: string | null,
  legacyId = id,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<ArtworkResolution> {
  if (signal?.aborted) return { artwork: null, duration_ms: target.duration_ms }
  const candidates: Uint8Array[] = []
  if (nativeBase64) {
    try {
      const maxBase64Length = Math.ceil(MAX_ARTWORK_BYTES / 3) * 4
      if (nativeBase64.length <= maxBase64Length) {
        const bytes = new Uint8Array(Buffer.from(nativeBase64, "base64"))
        if (bytes.byteLength <= MAX_ARTWORK_BYTES) candidates.push(bytes)
      }
    } catch {
      // Invalid system metadata falls through to the catalog lookup.
    }
  }

  for (const bytes of candidates) {
    try {
      const nativePng = await squarePng(bytes, 300)
      const thumbnail = nativePng ? await squarePng(nativePng, 24) : null
      if (nativePng && thumbnail) {
        return {
          artwork: {
            id,
            legacy_id: legacyId,
            png_base64: Buffer.from(nativePng).toString("base64"),
            ...presentation(thumbnail),
          },
          duration_ms: target.duration_ms,
        }
      }
    } catch {
      // Try the catalog when an app publishes unsupported artwork data.
    }
  }

  const catalog = await acquireCatalogArtwork(target, {
    fetch: fetcher,
    signal,
  })
  if (catalog.kind !== "available" || signal?.aborted)
    return {
      artwork: null,
      duration_ms: catalog.duration_ms ?? target.duration_ms,
    }
  if (!catalog.bytes) {
    return { artwork: null, duration_ms: catalog.duration_ms }
  }
  try {
    const nativePng = await squarePng(catalog.bytes, 300)
    const thumbnail = nativePng ? await squarePng(nativePng, 24) : null
    if (!nativePng || !thumbnail) {
      return { artwork: null, duration_ms: catalog.duration_ms }
    }
    return {
      artwork: {
        id,
        legacy_id: legacyId,
        png_base64: Buffer.from(nativePng).toString("base64"),
        ...presentation(thumbnail),
      },
      duration_ms: catalog.duration_ms,
    }
  } catch {
    return { artwork: null, duration_ms: catalog.duration_ms }
  }
}

export async function resolveArtwork(
  id: string,
  target: TrackIdentity,
  nativeBase64: string | null,
): Promise<Artwork | null> {
  return (await resolveArtworkDetails(id, target, nativeBase64)).artwork
}
