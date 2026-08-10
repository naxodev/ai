import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PNG } from "pngjs"
import type { Artwork } from "./types.ts"

const MAX_ARTWORK_BYTES = 3_000_000
const MAX_CATALOG_RESPONSE_BYTES = 512_000
const MAX_CONVERTED_PNG_BYTES = 1_000_000
const MAX_IMAGE_DIMENSION = 4_096
const MAX_IMAGE_PIXELS = 12_000_000
const FETCH_TIMEOUT_MS = 4_000
const CONVERSION_TIMEOUT_MS = 3_000
// MediaRemote may expose whole seconds while catalogs retain milliseconds.
const DURATION_TOLERANCE_MS = 1_000
const MAX_CATALOG_DURATION_MS = 24 * 60 * 60 * 1_000

type TrackIdentity = {
  title: string
  artist: string
  album: string
  duration_ms: number
}

export type CatalogTrack = {
  trackName?: string
  artistName?: string
  collectionName?: string
  trackTimeMillis?: number
  artworkUrl100?: string
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

function normalized(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/’/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

export function selectArtworkUrl(
  target: TrackIdentity,
  results: CatalogTrack[],
): string | null {
  return selectCatalogResolution(target, results).artworkUrl
}

function matchingCatalogTracks(
  target: TrackIdentity,
  results: CatalogTrack[],
): CatalogTrack[] {
  const title = normalized(target.title)
  const artist = normalized(target.artist)
  const album = normalized(target.album)
  if (!title || !artist) return []

  let matches = results.filter(
    (item) =>
      normalized(item.trackName) === title &&
      normalized(item.artistName) === artist,
  )
  if (album) {
    matches = matches.filter(
      (item) => normalized(item.collectionName) === album,
    )
  }
  return matches
}

function selectArtworkTrack(
  target: TrackIdentity,
  results: CatalogTrack[],
): CatalogTrack | null {
  let matches = matchingCatalogTracks(target, results).filter(
    (item) => typeof item.artworkUrl100 === "string",
  )
  if (target.duration_ms > 0) {
    matches = matches.filter(
      (item) =>
        validCatalogDuration(item.trackTimeMillis) &&
        Math.abs(item.trackTimeMillis! - target.duration_ms) <=
          DURATION_TOLERANCE_MS,
    )
  }
  return matches[0] ?? null
}

function validCatalogDuration(value: number | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_CATALOG_DURATION_MS
  )
}

export function selectCatalogTrack(
  target: TrackIdentity,
  results: CatalogTrack[],
): CatalogTrack | null {
  let matches = matchingCatalogTracks(target, results).filter((item) =>
    validCatalogDuration(item.trackTimeMillis),
  )
  if (target.duration_ms > 0) {
    matches = matches.filter(
      (item) =>
        Math.abs(item.trackTimeMillis! - target.duration_ms) <=
        DURATION_TOLERANCE_MS,
    )
  }
  if ((!target.album || target.duration_ms <= 0) && matches.length > 1) {
    const firstDuration = matches[0]!.trackTimeMillis!
    if (
      matches.some(
        (item) =>
          Math.abs(item.trackTimeMillis! - firstDuration) >
          DURATION_TOLERANCE_MS,
      )
    ) {
      return null
    }
  }

  return matches[0] ?? null
}

export function selectCatalogResolution(
  target: TrackIdentity,
  results: CatalogTrack[],
): { artworkUrl: string | null; duration_ms: number } {
  const artworkMatch = selectArtworkTrack(target, results)
  const durationMatch = selectCatalogTrack(target, results)
  return {
    artworkUrl:
      artworkMatch?.artworkUrl100?.replace(/100x100(?=[a-z]*\.)/, "300x300") ??
      null,
    duration_ms: durationMatch?.trackTimeMillis ?? target.duration_ms,
  }
}

function allowedCatalogImageUrl(raw: string | URL): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:" || !url.hostname.endsWith(".mzstatic.com")) {
      return null
    }
    return url
  } catch {
    return null
  }
}

export async function readLimitedResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!response.body) return new Uint8Array()

  const bytes = new Uint8Array(maxBytes)
  const reader = response.body.getReader()
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (total + value.byteLength > maxBytes) {
        await reader.cancel("artwork exceeds byte limit")
        return null
      }
      bytes.set(value, total)
      total += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }

  return bytes.slice(0, total)
}

export async function downloadCatalogImage(
  rawUrl: string,
  fetcher: Fetcher = fetch,
): Promise<Uint8Array | null> {
  const url = allowedCatalogImageUrl(rawUrl)
  if (!url) return null
  try {
    const response = await fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok || response.redirected) return null
    if (response.url && !allowedCatalogImageUrl(response.url)) return null
    return readLimitedResponse(response, MAX_ARTWORK_BYTES)
  } catch {
    return null
  }
}

async function catalogArtwork(
  target: TrackIdentity,
): Promise<{ bytes: Uint8Array; duration_ms: number } | null> {
  if (!target.title || !target.artist) return null
  const term = [target.artist, target.title, target.album]
    .filter(Boolean)
    .join(" ")
  const url = new URL("https://itunes.apple.com/search")
  url.searchParams.set("term", term)
  url.searchParams.set("entity", "song")
  url.searchParams.set("limit", "10")

  try {
    const result = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!result.ok || result.redirected) return null
    const responseBytes = await readLimitedResponse(
      result,
      MAX_CATALOG_RESPONSE_BYTES,
    )
    if (!responseBytes) return null
    const payload = JSON.parse(new TextDecoder().decode(responseBytes)) as {
      results?: CatalogTrack[]
    }
    const results = payload.results ?? []
    const resolution = selectCatalogResolution(target, results)
    const bytes = resolution.artworkUrl
      ? await downloadCatalogImage(resolution.artworkUrl)
      : null
    return bytes
      ? {
          bytes,
          duration_ms: resolution.duration_ms,
        }
      : null
  } catch {
    return null
  }
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
): Promise<ArtworkResolution> {
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

  const catalog = await catalogArtwork(target)
  if (!catalog) return { artwork: null, duration_ms: target.duration_ms }
  try {
    const nativePng = await squarePng(catalog.bytes, 300)
    const thumbnail = nativePng ? await squarePng(nativePng, 24) : null
    if (!nativePng || !thumbnail) {
      return { artwork: null, duration_ms: catalog.duration_ms }
    }
    return {
      artwork: {
        id,
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
