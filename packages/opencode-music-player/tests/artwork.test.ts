import { describe, expect, test } from "bun:test"
import { PNG } from "pngjs"
import {
  downloadCatalogImage,
  imageDimensionsAreSafe,
  pngDimensions,
  readLimitedResponse,
  resolveArtworkDetails,
  runCommandWithTimeout,
  selectCatalogResolution,
  selectCatalogTrack,
  selectArtworkUrl,
} from "../artwork.ts"

describe("artwork catalog matching", () => {
  const target = {
    title: "Jarred",
    artist: "Kiasmos",
    album: "Blurred",
    duration_ms: 335_000,
  }

  test("prefers the exact recording over similarly named mixes", () => {
    expect(
      selectArtworkUrl(target, [
        {
          trackName: "Jarred (Mixed)",
          artistName: "Kiasmos",
          collectionName: "Early Hours",
          trackTimeMillis: 206_000,
          artworkUrl100: "https://example.com/mix/100x100bb.jpg",
        },
        {
          trackName: "Jarred",
          artistName: "Kiasmos",
          collectionName: "Blurred",
          trackTimeMillis: 335_507,
          artworkUrl100: "https://example.com/original/100x100bb.jpg",
        },
      ]),
    ).toBe("https://example.com/original/300x300bb.jpg")
  })

  test("rejects results for another artist", () => {
    expect(
      selectArtworkUrl(target, [
        {
          trackName: "Jarred",
          artistName: "Someone Else",
          collectionName: "Blurred",
          artworkUrl100: "https://example.com/wrong/100x100bb.jpg",
        },
      ]),
    ).toBeNull()
  })

  test("rejects another recording when album and duration disagree", () => {
    expect(
      selectArtworkUrl(target, [
        {
          trackName: "Jarred",
          artistName: "Kiasmos",
          collectionName: "Unrelated compilation",
          trackTimeMillis: 120_000,
          artworkUrl100: "https://example.com/wrong/100x100bb.jpg",
        },
      ]),
    ).toBeNull()
  })

  test("does not erase punctuation that distinguishes catalog titles", () => {
    expect(
      selectArtworkUrl({ ...target, title: "Jarred: Part I" }, [
        {
          trackName: "Jarred Part I",
          artistName: target.artist,
          collectionName: target.album,
          trackTimeMillis: target.duration_ms,
          artworkUrl100: "https://example.com/wrong/100x100bb.jpg",
        },
      ]),
    ).toBeNull()
  })

  test("uses exact title and artist when richer metadata is unavailable", () => {
    const result = {
      trackName: "Song",
      artistName: "Artist",
      collectionName: "Album",
      trackTimeMillis: 180_000,
      artworkUrl100: "https://example.com/wrong/100x100bb.jpg",
    }

    expect(
      selectArtworkUrl(
        { title: "Song", artist: "Artist", album: "", duration_ms: 180_000 },
        [result],
      ),
    ).toBe("https://example.com/wrong/300x300bb.jpg")
    expect(
      selectArtworkUrl(
        { title: "Song", artist: "Artist", album: "Album", duration_ms: 0 },
        [result],
      ),
    ).toBe("https://example.com/wrong/300x300bb.jpg")
    expect(
      selectCatalogTrack(
        { title: "Song", artist: "Artist", album: "", duration_ms: 0 },
        [result],
      )?.trackTimeMillis,
    ).toBe(180_000)
  })

  test("rejects ambiguous and invalid metadata-limited durations", () => {
    const candidate = (duration: number, suffix: string) => ({
      trackName: "Song",
      artistName: "Artist",
      collectionName: suffix,
      trackTimeMillis: duration,
      artworkUrl100: `https://example.com/${suffix}/100x100bb.jpg`,
    })
    const sparse = {
      title: "Song",
      artist: "Artist",
      album: "",
      duration_ms: 0,
    }

    expect(
      selectCatalogTrack(sparse, [
        candidate(180_000, "original"),
        candidate(240_000, "other"),
      ]),
    ).toBeNull()
    expect(
      selectArtworkUrl(sparse, [
        candidate(180_000, "original"),
        candidate(240_000, "other"),
      ]),
    ).toBeNull()
    expect(
      selectCatalogResolution(sparse, [
        candidate(180_000, "original"),
        {
          trackName: "Song",
          artistName: "Artist",
          collectionName: "other",
          trackTimeMillis: 240_000,
        },
      ]),
    ).toEqual({
      artworkUrl: null,
      duration_ms: 0,
    })
    expect(
      selectArtworkUrl(sparse, [
        {
          trackName: "Song",
          artistName: "Artist",
          collectionName: "original",
          artworkUrl100: "https://example.com/original/100x100bb.jpg",
        },
      ]),
    ).toBe("https://example.com/original/300x300bb.jpg")
    expect(
      selectCatalogTrack(sparse, [
        candidate(180_000, "original"),
        candidate(180_500, "compilation"),
      ]),
    ).toBeNull()
    expect(selectCatalogTrack(sparse, [candidate(0, "invalid")])).toBeNull()
    expect(
      selectCatalogTrack(sparse, [candidate(86_400_001, "invalid")]),
    ).toBeNull()
  })

  test("allows provider rounding but rejects recordings over one second apart", () => {
    const result = (duration: number) => ({
      trackName: "Jarred",
      artistName: "Kiasmos",
      collectionName: "Blurred",
      trackTimeMillis: duration,
      artworkUrl100: "https://example.com/cover/100x100bb.jpg",
    })

    expect(
      selectArtworkUrl(target, [result(target.duration_ms + 1_000)]),
    ).not.toBeNull()
    expect(
      selectArtworkUrl(target, [result(target.duration_ms + 1_001)]),
    ).toBeNull()
  })
})

describe("artwork download boundaries", () => {
  const target = {
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration_ms: 0,
  }

  test("returns catalog duration when the accepted result has no cover", async () => {
    const fetcher = async () =>
      Response.json({
        results: [
          {
            trackName: "Song",
            artistName: "Artist",
            collectionName: "Album",
            trackTimeMillis: 180_000,
          },
        ],
      })

    expect(
      await resolveArtworkDetails(
        "cache-id",
        target,
        null,
        "legacy-id",
        fetcher,
      ),
    ).toEqual({
      artwork: null,
      duration_ms: 180_000,
    })
  })

  test("returns catalog duration when downloading its cover fails", async () => {
    let calls = 0
    const fetcher = async () => {
      calls++
      if (calls === 1) {
        return Response.json({
          results: [
            {
              trackName: "Song",
              artistName: "Artist",
              collectionName: "Album",
              trackTimeMillis: 180_000,
              artworkUrl100: "https://is1-ssl.mzstatic.com/image/100x100bb.jpg",
            },
          ],
        })
      }
      return new Response(null, { status: 503 })
    }

    expect(
      await resolveArtworkDetails(
        "cache-id",
        target,
        null,
        "legacy-id",
        fetcher,
      ),
    ).toEqual({
      artwork: null,
      duration_ms: 180_000,
    })
    expect(calls).toBe(4)
  })

  test("forbids redirects so an allowed CDN cannot redirect to another host", async () => {
    let redirect: RequestRedirect | undefined
    const fetcher = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      redirect = init?.redirect
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      })
    }

    expect(
      await downloadCatalogImage(
        "https://is1-ssl.mzstatic.com/cover.jpg",
        fetcher,
      ),
    ).toBeNull()
    expect(redirect).toBe("manual")
  })

  test("stops reading once a streamed image exceeds the byte cap", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6))
          controller.enqueue(new Uint8Array(5))
        },
        cancel() {
          cancelled = true
        },
      }),
    )

    expect(await readLimitedResponse(response, 10)).toBeNull()
    expect(cancelled).toBe(true)
  })

  test("enforces the production 3 MB cap without buffering the full download", async () => {
    let cancelled = false
    const fetcher = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(3_000_000))
            controller.enqueue(new Uint8Array(1))
          },
          cancel() {
            cancelled = true
          },
        }),
      )

    expect(
      await downloadCatalogImage(
        "https://is1-ssl.mzstatic.com/cover.jpg",
        fetcher,
      ),
    ).toBeNull()
    expect(cancelled).toBe(true)
  })
})

describe("artwork conversion boundaries", () => {
  test("native geometry reads only safe PNG headers", () => {
    const image = new PNG({ width: 80, height: 40 })
    const png = PNG.sync.write(image)
    expect(pngDimensions(png.toString("base64"))).toEqual({
      width: 80,
      height: 40,
    })
    expect(pngDimensions("not a PNG")).toBeNull()
    expect(pngDimensions(png.subarray(0, 20).toString("base64"))).toBeNull()
    const oversized = Buffer.from(png)
    oversized.writeUInt32BE(4_097, 16)
    expect(pngDimensions(oversized.toString("base64"))).toBeNull()
  })

  test.skipIf(process.platform !== "darwin")(
    "thin native and catalog covers keep at least one pixel on each axis",
    async () => {
      for (const [width, height] of [
        [80, 1],
        [1, 80],
      ] as const) {
        const image = new PNG({ width, height })
        image.data.fill(255)
        const bytes = PNG.sync.write(image)
        for (const source of ["native", "catalog"] as const) {
          let requests = 0
          const result = await resolveArtworkDetails(
            `thin-${source}-${width}-${height}`,
            {
              title: "Thin cover",
              artist: "Artist",
              album: "",
              duration_ms: 1_000,
            },
            source === "native" ? bytes.toString("base64") : null,
            undefined,
            async () => {
              requests++
              return requests === 1
                ? Response.json({
                    results: [
                      {
                        trackName: "Thin cover",
                        artistName: "Artist",
                        trackTimeMillis: 1_000,
                        artworkUrl100:
                          "https://is1-ssl.mzstatic.com/100x100bb.png",
                      },
                    ],
                  })
                : new Response(new Uint8Array(bytes))
            },
          )
          expect(result.artwork).not.toBeNull()
          if (!result.artwork) throw new Error("valid thin cover was rejected")
          const converted = PNG.sync.read(
            Buffer.from(result.artwork.png_base64, "base64"),
          )
          expect(
            Math.min(converted.width, converted.height),
          ).toBeGreaterThanOrEqual(1)
          expect(
            Math.max(converted.width, converted.height),
          ).toBeLessThanOrEqual(300)
          expect(result.artwork.cells.length).toBeGreaterThanOrEqual(1)
          expect(result.artwork.cells[0]!.length).toBeGreaterThanOrEqual(1)
          expect(requests).toBe(source === "native" ? 0 : 2)
        }
      }
    },
  )

  test.skipIf(process.platform !== "darwin")(
    "native covers retain landscape and portrait proportions",
    async () => {
      for (const [width, height] of [
        [80, 40],
        [40, 80],
      ] as const) {
        const image = new PNG({ width, height })
        for (let offset = 0; offset < image.data.length; offset += 4) {
          image.data[offset] = 20
          image.data[offset + 1] = 220
          image.data[offset + 2] = 40
          image.data[offset + 3] = 255
        }
        let catalogRequests = 0
        const result = await resolveArtworkDetails(
          `native-${width}-${height}`,
          {
            title: "Rectangular cover",
            artist: "Artist",
            album: "",
            duration_ms: 1_000,
          },
          PNG.sync.write(image).toString("base64"),
          undefined,
          async () => {
            catalogRequests++
            return new Response(null, { status: 404 })
          },
        )
        expect(result.artwork).not.toBeNull()
        if (!result.artwork) throw new Error("native cover conversion failed")
        const converted = PNG.sync.read(
          Buffer.from(result.artwork.png_base64, "base64"),
        )
        expect(converted.width / converted.height).toBeCloseTo(
          width / height,
          2,
        )
        expect(Math.max(converted.width, converted.height)).toBeLessThanOrEqual(
          300,
        )
        const rows = result.artwork.cells.length
        const columns = result.artwork.cells[0]!.length
        // Half-block cells represent two pixels vertically. The fallback must
        // preserve the same shape as the native image, rather than stretch it.
        expect(columns / (rows * 2)).toBeCloseTo(width / height, 2)
        expect(catalogRequests).toBe(0)
      }
    },
  )

  test("rejects dimensions that could expand into excessive decoded memory", () => {
    expect(imageDimensionsAreSafe(3_000, 3_000)).toBe(true)
    expect(imageDimensionsAreSafe(4_097, 1)).toBe(false)
    expect(imageDimensionsAreSafe(4_000, 4_000)).toBe(false)
  })

  test("kills an image conversion command after its hard deadline", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "await Bun.sleep(10_000)"],
      100,
    )

    expect(result.timed_out).toBe(true)
  })
})
