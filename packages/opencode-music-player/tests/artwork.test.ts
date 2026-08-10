import { describe, expect, test } from "bun:test"
import {
  downloadCatalogImage,
  imageDimensionsAreSafe,
  readLimitedResponse,
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
    ).toBe("https://example.com/original/300x300bb.jpg")
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
      artworkUrl: "https://example.com/original/300x300bb.jpg",
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
      ])?.collectionName,
    ).toBe("original")
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
    expect(redirect).toBe("error")
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
