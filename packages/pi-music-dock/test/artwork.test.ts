import { expect, test } from "bun:test";
import {
	acceptResolvedArtwork,
	allowedCatalogImageUrl,
	artworkFenceKey,
	detectImageMimeFromBase64,
	detectImageMimeFromBytes,
	downloadCatalogImage,
	imageDimensionsAreSafe,
	MAX_ARTWORK_BASE64_CHARS,
	MAX_ARTWORK_BYTES,
	MAX_CATALOG_RESPONSE_BYTES,
	MAX_IMAGE_DIMENSION,
	MAX_IMAGE_PIXELS,
	presentArtworkResult,
	readLimitedResponse,
	resolveArtworkPresentation,
	resolveCatalogArtwork,
	selectArtworkUrl,
	selectCatalogTrack,
	sniffBase64Bytes,
	trackArtworkIdentity,
	type ArtworkFetcher,
	type CatalogTrack,
	type ImageDimensionReader,
} from "../extensions/music-dock/artwork.ts";
import {
	BMP_BASE64,
	JPEG_1X1_BASE64,
	JPEG_1X1_BYTES,
	PNG_1X1_BASE64,
	PNG_1X1_BYTES,
	PNG_HUGE_BASE64,
	PNG_TRUNCATED_BASE64,
	jpegWithDimensions,
	pngHeaderWithDimensions,
} from "./artwork-fixtures.ts";

const png = PNG_1X1_BASE64;
const jpeg = JPEG_1X1_BASE64;
const jpegBytes = JPEG_1X1_BYTES;
const gif = Buffer.from("GIF89a\x01\x00\x01\x00......", "binary").toString(
	"base64",
);
const webp = (() => {
	// RIFF....WEBP VP8X with 1x1 canvas
	const buf = Buffer.alloc(30);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(22, 4);
	buf.write("WEBP", 8);
	buf.write("VP8X", 12);
	buf.writeUInt32LE(10, 16);
	// canvas width-1 / height-1 little-endian 24-bit at 24 and 27
	buf[24] = 0;
	buf[25] = 0;
	buf[26] = 0;
	buf[27] = 0;
	buf[28] = 0;
	buf[29] = 0;
	return buf.toString("base64");
})();
const bmp = BMP_BASE64;

const target = {
	title: "Video Club",
	artist: "Cerrone",
	album: "The Collector",
	duration_ms: 335_000,
};

const exactHit = (
	url = "https://is1-ssl.mzstatic.com/image/100x100bb.jpg",
): CatalogTrack => ({
	trackName: "Video Club",
	artistName: "Cerrone",
	collectionName: "The Collector",
	trackTimeMillis: 335_400,
	artworkUrl100: url,
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		...init,
	});
}

function bytesResponse(bytes: Uint8Array, init: ResponseInit = {}) {
	return new Response(Buffer.from(bytes), {
		status: 200,
		headers: { "content-type": "image/jpeg", ...(init.headers ?? {}) },
		...init,
	});
}

/** Safe dimension reader for fixtures that already passed MIME sniff. */
const safeDims: ImageDimensionReader = () => ({ widthPx: 1, heightPx: 1 });

test("MIME detection accepts PNG/JPEG/GIF/WebP only from bounded base64", () => {
	// Why: the daemon returns opaque base64; the panel must classify locally
	// without widening the core protocol or trusting remote Content-Type.
	expect(detectImageMimeFromBase64(png)).toBe("image/png");
	expect(detectImageMimeFromBase64(jpeg)).toBe("image/jpeg");
	expect(detectImageMimeFromBase64(gif)).toBe("image/gif");
	expect(detectImageMimeFromBase64(webp)).toBe("image/webp");
	expect(detectImageMimeFromBase64(bmp)).toBeNull();
	expect(detectImageMimeFromBase64("not-base64!!!")).toBeNull();
	expect(detectImageMimeFromBase64("")).toBeNull();
	expect(detectImageMimeFromBytes(jpegBytes)).toBe("image/jpeg");
});

test("sniff rejects oversized base64 before allocating a full decode", () => {
	// Why: a hostile or huge artwork payload must not force a multi-MB Buffer
	// just to decide the MIME type.
	const huge = "A".repeat(MAX_ARTWORK_BASE64_CHARS + 4);
	expect(sniffBase64Bytes(huge)).toBeNull();
	expect(detectImageMimeFromBase64(huge)).toBeNull();
	const sample = sniffBase64Bytes(png, 8);
	expect(sample?.byteLength).toBeLessThanOrEqual(8);
});

test("presentArtworkResult maps protocol outcomes and requires safe dimensions", () => {
	// Why: unavailable/stale/too-large must become honest placeholders, and an
	// available payload with unknown bytes must not be fed to pi-tui Image.
	// Dimensions must be validated — Image defaults unknown dims to 800×600 and
	// can still ship a decompression bomb to the terminal.
	expect(presentArtworkResult({ type: "unavailable" })).toEqual({
		kind: "unavailable",
	});
	expect(presentArtworkResult({ type: "too-large" })).toEqual({
		kind: "unavailable",
	});
	expect(presentArtworkResult({ type: "stale" })).toEqual({ kind: "empty" });
	expect(presentArtworkResult({ type: "available", base64: bmp })).toEqual({
		kind: "unsupported",
	});
	expect(presentArtworkResult({ type: "available", base64: png })).toEqual({
		kind: "ready",
		artwork: { base64: png, mime: "image/png" },
	});
	expect(
		presentArtworkResult({ type: "available", base64: PNG_TRUNCATED_BASE64 }),
	).toEqual({ kind: "unsupported" });
	expect(
		presentArtworkResult({ type: "available", base64: PNG_HUGE_BASE64 }),
	).toEqual({ kind: "unsupported" });
});

test("imageDimensionsAreSafe matches OpenCode pixel bounds", () => {
	// Why: shared limits prevent pi-tui from rendering multi-gigapixel bombs.
	expect(imageDimensionsAreSafe(1, 1)).toBe(true);
	// 4096×2929 ≈ 12M — within both side and pixel caps.
	expect(imageDimensionsAreSafe(MAX_IMAGE_DIMENSION, 2_929)).toBe(true);
	// 4096×4096 exceeds MAX_IMAGE_PIXELS even though each side is at the limit.
	expect(imageDimensionsAreSafe(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION)).toBe(
		false,
	);
	expect(imageDimensionsAreSafe(0, 100)).toBe(false);
	expect(imageDimensionsAreSafe(100, -1)).toBe(false);
	expect(imageDimensionsAreSafe(1.5, 100)).toBe(false);
	expect(imageDimensionsAreSafe(MAX_IMAGE_DIMENSION + 1, 1)).toBe(false);
	expect(imageDimensionsAreSafe(4000, 4000)).toBe(false); // > 12M pixels
	expect(MAX_IMAGE_PIXELS).toBe(12_000_000);
});

test("acceptResolvedArtwork rejects malformed headers and huge dimensions", () => {
	// Why: MIME-only magic is not enough — truncated headers and 10000×10000
	// IHDR values must never become kind:ready.
	expect(acceptResolvedArtwork(PNG_TRUNCATED_BASE64, "image/png").kind).toBe(
		"unsupported",
	);
	expect(acceptResolvedArtwork(PNG_HUGE_BASE64, "image/png").kind).toBe(
		"unsupported",
	);
	expect(
		acceptResolvedArtwork(
			pngHeaderWithDimensions(0, 100).toString("base64"),
			"image/png",
		).kind,
	).toBe("unsupported");
	expect(
		acceptResolvedArtwork(
			jpegWithDimensions(5000, 10).toString("base64"),
			"image/jpeg",
		).kind,
	).toBe("unsupported");
	// Injected seam: prove pixel-product rejection without a real multi-MB file.
	const bombDims: ImageDimensionReader = () => ({
		widthPx: 4000,
		heightPx: 4000,
	});
	expect(acceptResolvedArtwork(png, "image/png", bombDims).kind).toBe(
		"unsupported",
	);
	expect(acceptResolvedArtwork(png, "image/png", safeDims).kind).toBe("ready");
});

test("track artwork identity and fence key pin the exact current track", () => {
	// Why: late artwork for track A must not paint over track B after a skip.
	const identity = trackArtworkIdentity({
		id: "id-1",
		uri: "uri-1",
		name: "Song",
		artists: "Artist",
		album: "Album",
		duration_ms: 120_000,
	});
	expect(identity).toEqual({
		id: "id-1",
		name: "Song",
		artists: "Artist",
		album: "Album",
		duration_ms: 120_000,
	});
	expect(artworkFenceKey(identity)).not.toBe(
		artworkFenceKey({ ...identity, name: "Other" }),
	);
});

test("catalog matching requires exact title+artist, album when present, duration ±1s", () => {
	// Why: a wrong cover is worse than none — only the exact recording may win.
	expect(selectArtworkUrl(target, [exactHit()])).toBe(
		"https://is1-ssl.mzstatic.com/image/300x300bb.png",
	);
	expect(
		selectArtworkUrl(target, [{ ...exactHit(), artistName: "Someone Else" }]),
	).toBeNull();
	expect(
		selectArtworkUrl(target, [
			{ ...exactHit(), collectionName: "Other Album" },
		]),
	).toBeNull();
	expect(
		selectArtworkUrl(target, [{ ...exactHit(), trackTimeMillis: 120_000 }]),
	).toBeNull();
	expect(selectArtworkUrl({ ...target, duration_ms: 0 }, [exactHit()])).toBe(
		"https://is1-ssl.mzstatic.com/image/300x300bb.png",
	);
	expect(
		selectArtworkUrl(
			{ title: "Song", artist: "Artist", album: "", duration_ms: 0 },
			[
				{
					trackName: "Song",
					artistName: "Artist",
					collectionName: "A",
					trackTimeMillis: 180_000,
					artworkUrl100: "https://is1-ssl.mzstatic.com/a/100x100bb.jpg",
				},
				{
					trackName: "Song",
					artistName: "Artist",
					collectionName: "B",
					trackTimeMillis: 240_000,
					artworkUrl100: "https://is1-ssl.mzstatic.com/b/100x100bb.jpg",
				},
			],
		),
	).toBeNull();
	expect(
		selectCatalogTrack(target, [{ ...exactHit(), trackTimeMillis: 335_900 }])
			?.trackTimeMillis,
	).toBe(335_900);
});

test("catalog image URL allowlist rejects foreign hosts and non-HTTPS", () => {
	// Why: only Apple CDN hosts are trusted for cover bytes.
	expect(
		allowedCatalogImageUrl("https://is1-ssl.mzstatic.com/x.jpg"),
	).not.toBeNull();
	expect(
		allowedCatalogImageUrl("http://is1-ssl.mzstatic.com/x.jpg"),
	).toBeNull();
	expect(allowedCatalogImageUrl("https://evil.example/x.jpg")).toBeNull();
	expect(allowedCatalogImageUrl("https://mzstatic.com.evil/x.jpg")).toBeNull();
});

test("readLimitedResponse and download reject oversize, redirects, and foreign final URLs", async () => {
	// Why: bounds stop multi-MB JSON/images and redirect escapes from filling memory.
	const oversizeHeader = new Response("x", {
		status: 200,
		headers: { "content-length": String(MAX_ARTWORK_BYTES + 1) },
	});
	expect(
		await readLimitedResponse(oversizeHeader, MAX_ARTWORK_BYTES),
	).toBeNull();

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(MAX_CATALOG_RESPONSE_BYTES + 1));
			controller.close();
		},
	});
	expect(
		await readLimitedResponse(
			new Response(stream, { status: 200 }),
			MAX_CATALOG_RESPONSE_BYTES,
		),
	).toBeNull();

	expect(
		await downloadCatalogImage("https://is1-ssl.mzstatic.com/x.jpg", async () =>
			bytesResponse(jpegBytes),
		),
	).not.toBeNull();

	expect(
		await downloadCatalogImage("https://evil.example/x.jpg", async () =>
			bytesResponse(jpegBytes),
		),
	).toBeNull();

	const redirectedOk: ArtworkFetcher = async () => {
		const response = bytesResponse(jpegBytes);
		Object.defineProperty(response, "redirected", { value: true });
		return response;
	};
	expect(
		await downloadCatalogImage(
			"https://is1-ssl.mzstatic.com/x.jpg",
			redirectedOk,
		),
	).toBeNull();

	const foreignFinal: ArtworkFetcher = async () => {
		const response = bytesResponse(jpegBytes);
		Object.defineProperty(response, "url", {
			value: "https://evil.example/stolen.jpg",
		});
		return response;
	};
	expect(
		await downloadCatalogImage(
			"https://is1-ssl.mzstatic.com/x.jpg",
			foreignFinal,
		),
	).toBeNull();
});

test("native success avoids the catalog entirely", async () => {
	// Why: when the daemon already has valid art, never spend a network round-trip.
	let catalogHits = 0;
	const fetch: ArtworkFetcher = async () => {
		catalogHits++;
		throw new Error("catalog must not run");
	};
	const presentation = await resolveArtworkPresentation({
		identity: {
			id: "t1",
			name: target.title,
			artists: target.artist,
			album: target.album,
			duration_ms: target.duration_ms,
		},
		loadNative: async () => ({ type: "available", base64: png }),
		fetch,
		signal: new AbortController().signal,
	});
	expect(presentation).toEqual({
		kind: "ready",
		artwork: { base64: png, mime: "image/png" },
	});
	expect(catalogHits).toBe(0);
});

test("native JPEG falls back to a catalog PNG compatible with Kitty rendering", async () => {
	// Why: pi-tui's Kitty encoder declares f=100 (PNG) for every image. Passing
	// native JPEG bytes through as ready makes Ghostty reject a blank placement.
	let catalogHits = 0;
	let imageUrl = "";
	const presentation = await resolveArtworkPresentation({
		identity: {
			id: "t1",
			name: target.title,
			artists: target.artist,
			// Match the observed VLC state: title/artist exist, but album and
			// duration are absent. One exact catalog recording may still win.
			album: "",
			duration_ms: 0,
		},
		loadNative: async () => ({ type: "available", base64: jpeg }),
		fetch: async (input) => {
			const href = String(input);
			if (href.includes("itunes.apple.com/search")) {
				catalogHits++;
				return jsonResponse({ results: [exactHit()] });
			}
			imageUrl = href;
			return bytesResponse(PNG_1X1_BYTES, {
				headers: { "content-type": "image/png" },
			});
		},
		signal: new AbortController().signal,
		getDimensions: safeDims,
	});
	expect(catalogHits).toBe(1);
	expect(imageUrl).toEndWith("/300x300bb.png");
	expect(presentation).toEqual({
		kind: "ready",
		artwork: { base64: png, mime: "image/png" },
	});
});

test("provider failure and too-large native results use exact catalog match", async () => {
	// Why: media-control often publishes ~1.5MB covers beyond the daemon bound.
	// Without catalog fallback the panel shows "no artwork" for real tracks.
	const identity = {
		id: "video-club",
		name: target.title,
		artists: target.artist,
		album: target.album,
		duration_ms: target.duration_ms,
	};

	const makeFetch = (): ArtworkFetcher => async (input) => {
		const href = String(input);
		if (href.includes("itunes.apple.com/search")) {
			return jsonResponse({ results: [exactHit()] });
		}
		if (href.includes("mzstatic.com")) {
			return bytesResponse(PNG_1X1_BYTES);
		}
		throw new Error(`unexpected fetch ${href}`);
	};

	const fromFailure = await resolveArtworkPresentation({
		identity,
		loadNative: async () => {
			throw new Error("PROVIDER_FAILURE");
		},
		fetch: makeFetch(),
		signal: new AbortController().signal,
		getDimensions: safeDims,
	});
	expect(fromFailure.kind).toBe("ready");
	if (fromFailure.kind === "ready") {
		expect(fromFailure.artwork.mime).toBe("image/png");
	}

	const fromTooLarge = await resolveArtworkPresentation({
		identity,
		loadNative: async () => ({ type: "too-large" }),
		fetch: makeFetch(),
		signal: new AbortController().signal,
		getDimensions: safeDims,
	});
	expect(fromTooLarge.kind).toBe("ready");

	const fromUnsupported = await resolveArtworkPresentation({
		identity,
		loadNative: async () => ({ type: "available", base64: bmp }),
		fetch: makeFetch(),
		signal: new AbortController().signal,
		getDimensions: safeDims,
	});
	expect(fromUnsupported.kind).toBe("ready");
});

test("native huge dimensions fall back to catalog once without looping", async () => {
	// Why: rejecting a bomb native payload must try catalog exactly once; a
	// second dimension failure must not re-enter catalog forever.
	let catalogHits = 0;
	const identity = {
		id: "t",
		name: target.title,
		artists: target.artist,
		album: target.album,
		duration_ms: target.duration_ms,
	};
	const fetch: ArtworkFetcher = async (input) => {
		const href = String(input);
		if (href.includes("itunes.apple.com/search")) {
			catalogHits++;
			return jsonResponse({ results: [exactHit()] });
		}
		return bytesResponse(PNG_1X1_BYTES);
	};
	const presentation = await resolveArtworkPresentation({
		identity,
		loadNative: async () => ({ type: "available", base64: PNG_HUGE_BASE64 }),
		fetch,
		signal: new AbortController().signal,
		getDimensions: (base64, mime) => {
			// Native huge header → null safety via real reader path for huge fixture;
			// catalog 1x1 uses safe dims when base64 is the 1x1 png.
			if (base64 === PNG_HUGE_BASE64)
				return { widthPx: 10_000, heightPx: 10_000 };
			if (mime === "image/png") return { widthPx: 1, heightPx: 1 };
			return null;
		},
	});
	expect(presentation.kind).toBe("ready");
	expect(catalogHits).toBe(1);

	// Catalog also bomb → unavailable, still one search.
	catalogHits = 0;
	const bothBomb = await resolveArtworkPresentation({
		identity,
		loadNative: async () => ({ type: "available", base64: PNG_HUGE_BASE64 }),
		fetch: async (input) => {
			const href = String(input);
			if (href.includes("itunes.apple.com/search")) {
				catalogHits++;
				return jsonResponse({ results: [exactHit()] });
			}
			return bytesResponse(pngHeaderWithDimensions(9000, 9000));
		},
		signal: new AbortController().signal,
	});
	expect(bothBomb.kind).toBe("unavailable");
	expect(catalogHits).toBe(1);
});

test("mismatched catalog metadata is rejected even when a cover URL exists", async () => {
	// Why: accepting the first search hit would show the wrong album art.
	const fetch: ArtworkFetcher = async (input) => {
		const href = String(input);
		if (href.includes("itunes.apple.com/search")) {
			return jsonResponse({
				results: [
					{
						trackName: "Video Club (Remix)",
						artistName: "Cerrone",
						collectionName: "The Collector",
						trackTimeMillis: 335_000,
						artworkUrl100: "https://is1-ssl.mzstatic.com/image/100x100bb.jpg",
					},
				],
			});
		}
		return bytesResponse(jpegBytes);
	};
	const presentation = await resolveArtworkPresentation({
		identity: {
			id: "t",
			name: target.title,
			artists: target.artist,
			album: target.album,
			duration_ms: target.duration_ms,
		},
		loadNative: async () => ({ type: "unavailable" }),
		fetch,
		signal: new AbortController().signal,
	});
	expect(presentation).toEqual({ kind: "unavailable" });
});

test("abort during catalog fallback yields unavailable and stops further work", async () => {
	// Why: track replacement/shutdown must cancel in-flight catalog I/O so a late
	// cover cannot paint the next session.
	const controller = new AbortController();
	let imageFetches = 0;
	const fetch: ArtworkFetcher = async (input) => {
		const href = String(input);
		if (href.includes("itunes.apple.com/search")) {
			controller.abort();
			return jsonResponse({ results: [exactHit()] });
		}
		imageFetches++;
		return bytesResponse(jpegBytes);
	};
	const presentation = await resolveArtworkPresentation({
		identity: {
			id: "t",
			name: target.title,
			artists: target.artist,
			album: target.album,
			duration_ms: target.duration_ms,
		},
		loadNative: async () => ({ type: "too-large" }),
		fetch,
		signal: controller.signal,
	});
	expect(presentation).toEqual({ kind: "unavailable" });
	expect(imageFetches).toBe(0);
});

test("current live track-style metadata resolves through catalog", async () => {
	// Why: provider failures must still produce ready JPEG/PNG presentation for
	// pi-tui Image when the catalog has an exact match with safe dimensions.
	const fetch: ArtworkFetcher = async (input) => {
		const href = String(input);
		if (href.includes("itunes.apple.com/search")) {
			return jsonResponse({ results: [exactHit()] });
		}
		if (href.includes("300x300")) return bytesResponse(PNG_1X1_BYTES);
		throw new Error(`unexpected ${href}`);
	};
	const resolved = await resolveCatalogArtwork(
		target,
		fetch,
		undefined,
		safeDims,
	);
	expect(resolved).not.toBeNull();
	expect(resolved?.mime).toBe("image/png");
	expect(detectImageMimeFromBase64(resolved!.base64)).toBe("image/png");
});
