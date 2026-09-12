/** Host-side catalog policy. No daemon state, image decoding, or presentation cache. */
import { Effect, Schedule } from "effect"
export type CatalogTarget = {
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
export type ArtworkFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
export const MAX_ARTWORK_BYTES = 3_000_000
export const MAX_CATALOG_RESPONSE_BYTES = 512_000
export const FETCH_TIMEOUT_MS = 4_000
export const DURATION_TOLERANCE_MS = 1_000

function normalized(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/’/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}
function validDuration(value: number | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 86_400_000
  )
}
function candidate(
  target: CatalogTarget,
  results: CatalogTrack[],
): CatalogTrack | null {
  const title = normalized(target.title)
  const artist = normalized(target.artist)
  const album = normalized(target.album)
  if (!title || !artist) return null
  let matches = results.filter(
    (item) =>
      normalized(item.trackName) === title &&
      normalized(item.artistName) === artist &&
      (!album || normalized(item.collectionName) === album),
  )
  if (target.duration_ms > 0)
    matches = matches.filter(
      (item) =>
        validDuration(item.trackTimeMillis) &&
        Math.abs(item.trackTimeMillis - target.duration_ms) <=
          DURATION_TOLERANCE_MS,
    )
  else if (matches.length !== 1) return null
  return matches[0] ?? null
}
export function selectCatalogTrack(
  target: CatalogTarget,
  results: CatalogTrack[],
): CatalogTrack | null {
  const match = candidate(target, results)
  return validDuration(match?.trackTimeMillis) ? match : null
}
export function selectCatalogResolution(
  target: CatalogTarget,
  results: CatalogTrack[],
): { artworkUrl: string | null; duration_ms: number } {
  const match = candidate(target, results)
  return {
    artworkUrl:
      match?.artworkUrl100?.replace(/100x100(?=[a-z]*\.)/, "300x300") ?? null,
    duration_ms: validDuration(match?.trackTimeMillis)
      ? match.trackTimeMillis
      : target.duration_ms,
  }
}
export function allowedCatalogImageUrl(raw: string | URL): URL | null {
  try {
    const url = new URL(raw)
    return url.protocol === "https:" &&
      url.hostname.endsWith(".mzstatic.com") &&
      !url.username &&
      !url.password &&
      !url.port
      ? url
      : null
  } catch {
    return null
  }
}

async function cancelBody(response: Response) {
  // Cancellation failure is settled cleanup, but pending cleanup still owns work.
  await response.body?.cancel("catalog response rejected").catch(() => {})
}

/** Cancel rejected or interrupted streams and always release the reader lock. */
export async function readLimitedResponse(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_ARTWORK_BYTES ||
    signal?.aborted ||
    Number(response.headers.get("content-length")) > maxBytes
  ) {
    await cancelBody(response)
    return null
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  let cancellation: Promise<void> | undefined
  const cancel = () => {
    cancellation ??= reader.cancel("catalog read cancelled").catch(() => {})
  }
  signal?.addEventListener("abort", cancel, { once: true })
  const bytes = new Uint8Array(maxBytes)
  let total = 0
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      if (signal?.aborted) return null
      if (done) return bytes.slice(0, total)
      if (total + value.byteLength > maxBytes) {
        cancel()
        return null
      }
      bytes.set(value, total)
      total += value.byteLength
    }
    cancel()
    return null
  } catch (error) {
    cancel()
    throw error
  } finally {
    signal?.removeEventListener("abort", cancel)
    await cancellation
    reader.releaseLock()
  }
}

type RequestResult =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "transient" | "unavailable" | "aborted" }
function sameResponseUrl(response: Response, url: URL): boolean {
  try {
    return !response.url || new URL(response.url).href === url.href
  } catch {
    return false
  }
}
async function request(
  url: URL,
  maxBytes: number,
  fetcher: ArtworkFetcher,
  signal: AbortSignal,
): Promise<RequestResult> {
  if (signal.aborted) return { kind: "aborted" }
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(abort, FETCH_TIMEOUT_MS)
  let owned: Response | undefined
  try {
    const response = await fetcher(url, {
      redirect: "manual",
      signal: controller.signal,
    })
    owned = response
    if (controller.signal.aborted) {
      await cancelBody(response)
      return { kind: signal.aborted ? "aborted" : "transient" }
    }
    if (response.redirected || !sameResponseUrl(response, url)) {
      await cancelBody(response)
      return { kind: "unavailable" }
    }
    if (!response.ok) {
      await cancelBody(response)
      return {
        kind:
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500
            ? "transient"
            : "unavailable",
      }
    }
    const bytes = await readLimitedResponse(
      response,
      maxBytes,
      controller.signal,
    )
    if (signal.aborted) return { kind: "aborted" }
    if (controller.signal.aborted) return { kind: "transient" }
    return bytes ? { kind: "bytes", bytes } : { kind: "unavailable" }
  } catch {
    return { kind: signal.aborted ? "aborted" : "transient" }
  } finally {
    if (owned && !owned.bodyUsed) await cancelBody(owned)
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}

export async function downloadCatalogImage(
  rawUrl: string,
  fetcher: ArtworkFetcher = fetch,
  signal: AbortSignal = new AbortController().signal,
): Promise<Uint8Array | null> {
  const url = allowedCatalogImageUrl(rawUrl)
  if (!url) return null
  const result = await request(url, MAX_ARTWORK_BYTES, fetcher, signal)
  return result.kind === "bytes" ? result.bytes : null
}

function parseTracks(bytes: Uint8Array): CatalogTrack[] | null {
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (
      !data ||
      typeof data !== "object" ||
      !("results" in data) ||
      !Array.isArray(data.results) ||
      data.results.length > 10
    )
      return null
    const tracks: CatalogTrack[] = []
    for (const item of data.results) {
      if (!item || typeof item !== "object") return null
      for (const key of [
        "trackName",
        "artistName",
        "collectionName",
        "artworkUrl100",
      ]) {
        if (item[key] !== undefined && typeof item[key] !== "string")
          return null
      }
      if (
        item.trackTimeMillis !== undefined &&
        typeof item.trackTimeMillis !== "number"
      )
        return null
      tracks.push({
        trackName: item.trackName,
        artistName: item.artistName,
        collectionName: item.collectionName,
        artworkUrl100: item.artworkUrl100,
        trackTimeMillis: item.trackTimeMillis,
      })
    }
    return tracks
  } catch {
    return null
  }
}

export type CatalogArtworkResult =
  | { kind: "available"; bytes: Uint8Array | null; duration_ms: number }
  | { kind: "unavailable" | "exhausted" | "aborted"; duration_ms?: number }

export type CatalogArtworkOptions = {
  fetch?: ArtworkFetcher
  signal?: AbortSignal | undefined
  /** May reduce the base delay for controlled tests, never raise its 500ms ceiling. */
  retryDelayMs?: number
  /** Pi requires PNG; OpenCode converts the original format locally. */
  format?: "original" | "png"
}

/** Three serial attempts, 500/1000ms delays, 26s total; no retry on mismatch or invalid data. */
export async function acquireCatalogArtwork(
  target: CatalogTarget,
  options: CatalogArtworkOptions = {},
): Promise<CatalogArtworkResult> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(abort, 26_000)
  const signal = controller.signal
  const fetcher = options.fetch ?? fetch
  let duration_ms = target.duration_ms
  let pending: Promise<CatalogArtworkResult | { kind: "transient" }> | undefined
  try {
    if (!normalized(target.title) || !normalized(target.artist))
      return { kind: "unavailable" }
    const url = new URL("https://itunes.apple.com/search")
    url.searchParams.set(
      "term",
      [target.artist, target.title, target.album].filter(Boolean).join(" "),
    )
    url.searchParams.set("entity", "song")
    url.searchParams.set("limit", "10")
    const attempt = async (): Promise<
      CatalogArtworkResult | { kind: "transient" }
    > => {
      if (signal.aborted)
        return { kind: options.signal?.aborted ? "aborted" : "exhausted" }
      const search = await request(
        url,
        MAX_CATALOG_RESPONSE_BYTES,
        fetcher,
        signal,
      )
      if (search.kind === "aborted")
        return { kind: options.signal?.aborted ? "aborted" : "exhausted" }
      if (search.kind === "transient") return search
      if (search.kind !== "bytes") return { kind: "unavailable" }
      const tracks = parseTracks(search.bytes)
      if (!tracks) return { kind: "unavailable" }
      const resolution = selectCatalogResolution(target, tracks)
      duration_ms = resolution.duration_ms
      if (!resolution.artworkUrl)
        return resolution.duration_ms !== target.duration_ms
          ? {
              kind: "available",
              bytes: null,
              duration_ms: resolution.duration_ms,
            }
          : { kind: "unavailable" }
      const imageUrl = allowedCatalogImageUrl(resolution.artworkUrl)
      if (!imageUrl) return { kind: "unavailable", duration_ms }
      if (options.format === "png") {
        const png = imageUrl.pathname.replace(/\.[a-z0-9]+$/i, ".png")
        if (!/\.png$/i.test(png)) return { kind: "unavailable" }
        imageUrl.pathname = png
      }
      const image = await request(imageUrl, MAX_ARTWORK_BYTES, fetcher, signal)
      if (image.kind === "transient") return image
      if (image.kind === "aborted")
        return { kind: options.signal?.aborted ? "aborted" : "exhausted" }
      if (image.kind !== "bytes") return { kind: "unavailable", duration_ms }
      return {
        kind: "available",
        bytes: image.bytes,
        duration_ms: resolution.duration_ms,
      }
    }
    const requestedDelay = options.retryDelayMs ?? 500
    const baseDelay = Number.isFinite(requestedDelay)
      ? Math.max(0, Math.min(500, requestedDelay))
      : 500
    const operation = Effect.promise(() => {
      pending = attempt()
      return pending
    }).pipe(
      Effect.flatMap((result) =>
        result.kind === "transient"
          ? Effect.fail("transient" as const)
          : Effect.succeed(result),
      ),
      Effect.retry(
        Schedule.exponential(baseDelay).pipe(Schedule.upTo({ times: 2 })),
      ),
      Effect.catch(() =>
        Effect.succeed({ kind: "exhausted" as const, duration_ms }),
      ),
    )
    try {
      return await Effect.runPromise(operation, { signal })
    } catch {
      return {
        kind: options.signal?.aborted ? "aborted" : "exhausted",
        duration_ms,
      }
    }
  } finally {
    // A host's physical job slot remains owned until its in-flight read settles.
    // Cooperative fetch aborts promptly; even a late injected response is released.
    await pending?.catch(() => {})
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}
