/** Local artwork presentation: native session result + bounded iTunes catalog fallback. */

import type { ArtworkIdentity, ArtworkResult } from "@naxodev/music-core";
import type { PlayerState } from "@naxodev/music-core";
import { getImageDimensions } from "@earendil-works/pi-tui";

/** Cap decoded sniff bytes so a huge base64 payload cannot allocate freely. */
export const ARTWORK_SNIFF_BYTES = 32;
/** Cap accepted base64 length before any decode (≈3MB decoded). */
export const MAX_ARTWORK_BASE64_CHARS = 4_000_000;
/** Catalog image download bound (decoded bytes). */
export const MAX_ARTWORK_BYTES = 3_000_000;
/** iTunes search JSON response bound. */
export const MAX_CATALOG_RESPONSE_BYTES = 512_000;
/** Network deadline for search and image download. */
export const FETCH_TIMEOUT_MS = 4_000;
/** MediaRemote may expose whole seconds while catalogs retain milliseconds. */
export const DURATION_TOLERANCE_MS = 1_000;
/** Same pixel bounds as OpenCode — stop decompression-bomb images reaching pi-tui. */
export const MAX_IMAGE_DIMENSION = 4_096;
export const MAX_IMAGE_PIXELS = 12_000_000;
const MAX_CATALOG_DURATION_MS = 24 * 60 * 60 * 1_000;

export type SupportedArtworkMime =
	"image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ResolvedArtwork = {
	readonly base64: string;
	readonly mime: SupportedArtworkMime;
	/** Exact catalog duration used only when provider presentation is sparse. */
	readonly duration_ms?: number;
};

export type ArtworkPresentation =
	| { readonly kind: "empty" }
	| { readonly kind: "loading" }
	| { readonly kind: "unavailable" }
	| { readonly kind: "unsupported" }
	| { readonly kind: "ready"; readonly artwork: ResolvedArtwork };

export type ArtworkFetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

/** Injected dimension seam — production uses pi-tui getImageDimensions. */
export type ImageDimensionReader = (
	base64: string,
	mime: string,
) => { widthPx: number; heightPx: number } | null;

export const defaultImageDimensions: ImageDimensionReader = getImageDimensions;

export type CatalogTrack = {
	trackName?: string;
	artistName?: string;
	collectionName?: string;
	trackTimeMillis?: number;
	artworkUrl100?: string;
};

export type TrackCatalogTarget = {
	title: string;
	artist: string;
	album: string;
	duration_ms: number;
};

/** Stable identity for the current exact track, used for fencing late completions. */
export function trackArtworkIdentity(
	track: NonNullable<PlayerState["track"]>,
): ArtworkIdentity {
	return {
		id: track.id || track.uri || track.name,
		name: track.name,
		artists: track.artists,
		album: track.album,
		duration_ms: track.duration_ms,
	};
}

/** Compact fence key so session + track identity comparisons stay cheap. */
export function artworkFenceKey(identity: ArtworkIdentity): string {
	return [
		identity.id,
		identity.name,
		identity.artists,
		identity.album,
		String(identity.duration_ms),
	].join("\0");
}

export function catalogTargetFromIdentity(
	identity: ArtworkIdentity,
): TrackCatalogTarget {
	return {
		title: identity.name,
		artist: identity.artists,
		album: identity.album,
		duration_ms: identity.duration_ms,
	};
}

function startsWith(
	bytes: Uint8Array,
	signature: readonly number[],
	offset = 0,
): boolean {
	if (bytes.length < offset + signature.length) return false;
	for (let i = 0; i < signature.length; i++) {
		if (bytes[offset + i] !== signature[i]) return false;
	}
	return true;
}

function startsWithAscii(
	bytes: Uint8Array,
	offset: number,
	text: string,
): boolean {
	if (bytes.length < offset + text.length) return false;
	for (let i = 0; i < text.length; i++) {
		if (bytes[offset + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

/**
 * Decode only the leading base64 quartets needed for magic-byte sniffing.
 * Rejects oversized or non-canonical-enough payloads without full decode.
 */
export function sniffBase64Bytes(
	base64: string,
	maxBytes = ARTWORK_SNIFF_BYTES,
): Uint8Array | null {
	if (!base64 || base64.length > MAX_ARTWORK_BASE64_CHARS) return null;
	if (base64.length % 4 !== 0) return null;
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
	const quartets = Math.ceil(maxBytes / 3);
	const slice = base64.slice(0, quartets * 4);
	try {
		const decoded = Buffer.from(slice, "base64");
		return decoded.subarray(0, Math.min(decoded.byteLength, maxBytes));
	} catch {
		return null;
	}
}

/** Detect PNG/JPEG/GIF/WebP from raw bytes (catalog download path). */
export function detectImageMimeFromBytes(
	bytes: Uint8Array,
): SupportedArtworkMime | null {
	if (!bytes || bytes.byteLength === 0) return null;
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
	if (startsWithAscii(bytes, 0, "GIF8")) return "image/gif";
	if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP"))
		return "image/webp";
	return null;
}

/**
 * Detect PNG/JPEG/GIF/WebP from bounded base64 locally.
 * Does not widen the session protocol; the daemon still returns opaque base64.
 */
export function detectImageMimeFromBase64(
	base64: string,
): SupportedArtworkMime | null {
	const bytes = sniffBase64Bytes(base64, ARTWORK_SNIFF_BYTES);
	if (!bytes) return null;
	return detectImageMimeFromBytes(bytes);
}

/** Same limits as OpenCode: integer >0, ≤4096 each side, ≤12M pixels. */
export function imageDimensionsAreSafe(width: number, height: number): boolean {
	return (
		Number.isInteger(width) &&
		Number.isInteger(height) &&
		width > 0 &&
		height > 0 &&
		width <= MAX_IMAGE_DIMENSION &&
		height <= MAX_IMAGE_DIMENSION &&
		width * height <= MAX_IMAGE_PIXELS
	);
}

/**
 * Accept base64+mime only after size, MIME, and dimension checks.
 * Untrusted external/native bytes must not reach pi-tui Image otherwise —
 * Image defaults unknown dimensions and can ship a decompression bomb.
 */
export function acceptResolvedArtwork(
	base64: string,
	mime: SupportedArtworkMime,
	getDimensions: ImageDimensionReader = defaultImageDimensions,
): ArtworkPresentation {
	try {
		const decoded = Buffer.from(base64, "base64");
		if (decoded.byteLength === 0 || decoded.byteLength > MAX_ARTWORK_BYTES)
			return { kind: "unavailable" };
	} catch {
		return { kind: "unsupported" };
	}
	const dims = getDimensions(base64, mime);
	if (!dims) return { kind: "unsupported" };
	if (!imageDimensionsAreSafe(dims.widthPx, dims.heightPx))
		return { kind: "unsupported" };
	return { kind: "ready", artwork: { base64, mime } };
}

/** Map a protocol artwork result into local presentation without trusting MIME. */
export function presentArtworkResult(
	result: ArtworkResult,
	getDimensions: ImageDimensionReader = defaultImageDimensions,
): ArtworkPresentation {
	if (result.type !== "available") {
		if (result.type === "stale") return { kind: "empty" };
		return { kind: "unavailable" };
	}
	const mime = detectImageMimeFromBase64(result.base64);
	if (!mime) return { kind: "unsupported" };
	return acceptResolvedArtwork(result.base64, mime, getDimensions);
}

function normalized(value: string | undefined): string {
	return (value ?? "")
		.normalize("NFKC")
		.replace(/’/g, "'")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function matchingCatalogTracks(
	target: TrackCatalogTarget,
	results: CatalogTrack[],
): CatalogTrack[] {
	const title = normalized(target.title);
	const artist = normalized(target.artist);
	const album = normalized(target.album);
	if (!title || !artist) return [];

	let matches = results.filter(
		(item) =>
			normalized(item.trackName) === title &&
			normalized(item.artistName) === artist,
	);
	if (album) {
		matches = matches.filter(
			(item) => normalized(item.collectionName) === album,
		);
	}
	return matches;
}

function validCatalogDuration(value: number | undefined): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value > 0 &&
		value <= MAX_CATALOG_DURATION_MS
	);
}

function selectCatalogCandidate(
	target: TrackCatalogTarget,
	results: CatalogTrack[],
): CatalogTrack | null {
	let matches = matchingCatalogTracks(target, results);
	if (target.duration_ms > 0) {
		matches = matches.filter(
			(item) =>
				validCatalogDuration(item.trackTimeMillis) &&
				Math.abs(item.trackTimeMillis! - target.duration_ms) <=
					DURATION_TOLERANCE_MS,
		);
	} else if (matches.length !== 1) {
		return null;
	}
	return matches[0] ?? null;
}

/** Exact catalog match → 300x300 PNG mzstatic URL, or null when ambiguous/wrong. */
export function selectArtworkUrl(
	target: TrackCatalogTarget,
	results: CatalogTrack[],
): string | null {
	const source = selectCatalogCandidate(target, results)?.artworkUrl100;
	if (!source) return null;
	const resized = source.replace(/100x100(?=[a-z]*\.)/, "300x300");
	const png = resized.replace(/\.[a-z0-9]+(?=([?#].*)?$)/i, ".png");
	return png === resized ? null : png;
}

export function selectCatalogTrack(
	target: TrackCatalogTarget,
	results: CatalogTrack[],
): CatalogTrack | null {
	const match = selectCatalogCandidate(target, results);
	return validCatalogDuration(match?.trackTimeMillis) ? match : null;
}

/** Only HTTPS hosts ending in .mzstatic.com. */
export function allowedCatalogImageUrl(raw: string | URL): URL | null {
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || !url.hostname.endsWith(".mzstatic.com"))
			return null;
		return url;
	} catch {
		return null;
	}
}

/** Stream a response body up to maxBytes; reject oversize content-length or stream. */
export async function readLimitedResponse(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array | null> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await cancelResponseBody(response, "artwork exceeds byte limit");
		return null;
	}
	if (!response.body) return new Uint8Array();

	const bytes = new Uint8Array(maxBytes);
	const reader = response.body.getReader();
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (total + value.byteLength > maxBytes) {
				try {
					await reader.cancel("artwork exceeds byte limit");
				} catch {
					// The size rejection remains authoritative if cancellation fails.
				}
				return null;
			}
			bytes.set(value, total);
			total += value.byteLength;
		}
	} catch (error) {
		try {
			await reader.cancel(error);
		} catch {
			// Preserve the read failure even when cancellation also fails.
		}
		throw error;
	} finally {
		reader.releaseLock();
	}
	return bytes.slice(0, total);
}

async function cancelResponseBody(response: Response, reason: string) {
	try {
		await response.body?.cancel(reason);
	} catch {
		// Rejection paths stay best-effort even when the stream is already errored.
	}
}

export async function downloadCatalogImage(
	rawUrl: string,
	fetcher: ArtworkFetcher,
	signal?: AbortSignal,
): Promise<Uint8Array | null> {
	const url = allowedCatalogImageUrl(rawUrl);
	if (!url) return null;
	try {
		const response = await fetcher(url, {
			redirect: "error",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
				: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok || response.redirected || signal?.aborted) {
			await cancelResponseBody(response, "artwork response rejected");
			return null;
		}
		if (response.url && !allowedCatalogImageUrl(response.url)) {
			await cancelResponseBody(response, "artwork response URL rejected");
			return null;
		}
		return readLimitedResponse(response, MAX_ARTWORK_BYTES);
	} catch {
		return null;
	}
}

/**
 * Bounded iTunes catalog lookup for exact track matches.
 * Never follows redirects; never leaves .mzstatic.com for images.
 */
export async function resolveCatalogArtwork(
	target: TrackCatalogTarget,
	fetcher: ArtworkFetcher,
	signal?: AbortSignal,
	getDimensions: ImageDimensionReader = defaultImageDimensions,
): Promise<ResolvedArtwork | null> {
	if (!target.title || !target.artist) return null;
	if (signal?.aborted) return null;

	try {
		const term = [target.artist, target.title, target.album]
			.filter(Boolean)
			.join(" ");
		const url = new URL("https://itunes.apple.com/search");
		url.searchParams.set("term", term);
		url.searchParams.set("entity", "song");
		url.searchParams.set("limit", "10");

		const result = await fetcher(url, {
			redirect: "error",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
				: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!result.ok || result.redirected || signal?.aborted) {
			await cancelResponseBody(result, "catalog response rejected");
			return null;
		}
		const responseBytes = await readLimitedResponse(
			result,
			MAX_CATALOG_RESPONSE_BYTES,
		);
		if (!responseBytes || signal?.aborted) return null;
		const payload = JSON.parse(new TextDecoder().decode(responseBytes)) as {
			results?: CatalogTrack[];
		};
		const results = payload.results ?? [];
		const artworkUrl = selectArtworkUrl(target, results);
		if (!artworkUrl) return null;
		const catalogDuration = selectCatalogTrack(
			target,
			results,
		)?.trackTimeMillis;
		const bytes = await downloadCatalogImage(artworkUrl, fetcher, signal);
		if (!bytes || signal?.aborted) return null;
		const mime = detectImageMimeFromBytes(bytes);
		if (!mime) return null;
		const base64 = Buffer.from(bytes).toString("base64");
		// Catalog bytes are untrusted too — reject bombs; no second fallback loop.
		const accepted = acceptResolvedArtwork(base64, mime, getDimensions);
		if (accepted.kind !== "ready") return null;
		return catalogDuration
			? { ...accepted.artwork, duration_ms: catalogDuration }
			: accepted.artwork;
	} catch {
		return null;
	}
}

function shouldFallbackToCatalog(presentation: ArtworkPresentation): boolean {
	return (
		presentation.kind === "unavailable" || presentation.kind === "unsupported"
	);
}

export type ResolveArtworkOptions = {
	identity: ArtworkIdentity;
	/** Load native artwork from the single session client. */
	loadNative: () => Promise<ArtworkResult>;
	fetch: ArtworkFetcher;
	signal: AbortSignal;
	/** Dimension reader seam — tests inject abuse dimensions without real headers. */
	getDimensions?: ImageDimensionReader;
};

/**
 * One small resolver: accept valid native art, else exact iTunes catalog match.
 * Callers fence by generation + identity and abort the signal on replacement.
 * Dimension rejection on native may fall back once to catalog; catalog never loops.
 */
export async function resolveArtworkPresentation(
	options: ResolveArtworkOptions,
): Promise<ArtworkPresentation> {
	const {
		identity,
		loadNative,
		fetch: fetcher,
		signal,
		getDimensions = defaultImageDimensions,
	} = options;
	if (signal.aborted) return { kind: "unavailable" };

	let nativePresentation: ArtworkPresentation = { kind: "unavailable" };
	try {
		const result = await loadNative();
		if (signal.aborted) return { kind: "unavailable" };
		nativePresentation = presentArtworkResult(result, getDimensions);
		if (
			nativePresentation.kind === "ready" &&
			nativePresentation.artwork.mime === "image/png"
		)
			return nativePresentation;
		if (nativePresentation.kind === "ready") {
			// pi-tui's Kitty path declares f=100 (PNG) for every payload. Native
			// JPEG/GIF/WebP bytes would create a blank Ghostty placement, so seek
			// an exact catalog PNG instead of handing mislabeled bytes to Image.
			nativePresentation = { kind: "unsupported" };
		}
	} catch {
		// PROVIDER_FAILURE and transport errors fall through to catalog.
		if (signal.aborted) return { kind: "unavailable" };
		nativePresentation = { kind: "unavailable" };
	}

	if (!shouldFallbackToCatalog(nativePresentation)) return nativePresentation;

	const catalog = await resolveCatalogArtwork(
		catalogTargetFromIdentity(identity),
		fetcher,
		signal,
		getDimensions,
	);
	if (signal.aborted) return { kind: "unavailable" };
	if (!catalog) return { kind: "unavailable" };
	return { kind: "ready", artwork: catalog };
}

/** Default production fetcher — tests inject a fake through MusicDockDependencies. */
export const defaultArtworkFetch: ArtworkFetcher = fetch;
