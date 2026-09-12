import { expect, test } from "bun:test"
import {
  acquireCatalogArtwork,
  allowedCatalogImageUrl,
  readLimitedResponse,
  type ArtworkFetcher,
} from "../catalog-artwork.ts"

const target = {
  title: "Song",
  artist: "Artist",
  album: "Album",
  duration_ms: 180_000,
}
const track = {
  trackName: "Song",
  artistName: "Artist",
  collectionName: "Album",
  trackTimeMillis: 180_500,
  artworkUrl100: "https://is1-ssl.mzstatic.com/cover/100x100bb.jpg",
}
const search = () => Response.json({ results: [track] })

test("retries and exhaustion wait for each response cancellation to settle", async () => {
  const starts = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
  const cleanups = Array.from({ length: 3 }, () =>
    Promise.withResolvers<void>(),
  )
  let calls = 0
  let settled = false
  const acquisition = acquireCatalogArtwork(target, {
    retryDelayMs: 0,
    fetch: async () => {
      const index = calls++
      return new Response(
        new ReadableStream({
          cancel() {
            starts[index]!.resolve()
            return cleanups[index]!.promise
          },
        }),
        { status: 503 },
      )
    },
  }).then((result) => {
    settled = true
    return result
  })
  for (let index = 0; index < 3; index++) {
    await starts[index]!.promise
    for (let turn = 0; turn < 30; turn++) await Promise.resolve()
    expect(calls).toBe(index + 1)
    expect(settled).toBe(false)
    if (index === 1) cleanups[index]!.reject(new Error("cleanup rejected"))
    else cleanups[index]!.resolve()
  }
  expect((await acquisition).kind).toBe("exhausted")
  expect(calls).toBe(3)
})

test("overflow and abort retain reader ownership through asynchronous cancellation, including rejection", async () => {
  for (const mode of ["declared", "streamed", "abort"] as const) {
    for (const rejects of [false, true]) {
      const cleanup = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const controller = new AbortController()
      let cancelled = 0
      let settled = false
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            if (mode !== "abort") stream.enqueue(new Uint8Array(11))
          },
          cancel() {
            cancelled++
            started.resolve()
            return cleanup.promise
          },
        }),
        { headers: mode === "declared" ? { "content-length": "11" } : {} },
      )
      const read = readLimitedResponse(response, 10, controller.signal).then(
        (result) => {
          settled = true
          return result
        },
      )
      if (mode === "abort") controller.abort()
      await started.promise
      for (let turn = 0; turn < 30; turn++) await Promise.resolve()
      expect(settled).toBe(false)
      expect(response.body?.locked).toBe(mode !== "declared")
      if (rejects) cleanup.reject(new Error("cancel failed"))
      else cleanup.resolve()
      expect(await read).toBeNull()
      expect(cancelled).toBe(1)
      expect(response.body?.locked).toBe(false)
    }
  }
})

test("acquisition abort retains pending response cleanup rather than releasing its physical slot", async () => {
  const controller = new AbortController()
  const cleanup = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  let settled = false
  let calls = 0
  const acquisition = acquireCatalogArtwork(target, {
    signal: controller.signal,
    retryDelayMs: 0,
    fetch: async () => {
      calls++
      return new Response(
        new ReadableStream({
          cancel() {
            started.resolve()
            return cleanup.promise
          },
        }),
        { status: 503 },
      )
    },
  }).then((result) => {
    settled = true
    return result
  })
  await started.promise
  controller.abort()
  for (let turn = 0; turn < 30; turn++) await Promise.resolve()
  expect(settled).toBe(false)
  expect(calls).toBe(1)
  cleanup.resolve()
  expect((await acquisition).kind).toBe("aborted")
  expect(calls).toBe(1)
})

test("the same identity recovers from a transient search failure within one acquisition", async () => {
  const urls: string[] = []
  const fetcher: ArtworkFetcher = async (url, init) => {
    urls.push(String(url))
    expect(init?.redirect).toBe("manual")
    if (urls.length === 1) return new Response(null, { status: 503 })
    return urls.length === 2
      ? search()
      : new Response(new Uint8Array([1, 2, 3]))
  }
  expect(
    await acquireCatalogArtwork(target, { fetch: fetcher, retryDelayMs: 0 }),
  ).toEqual({
    kind: "available",
    bytes: new Uint8Array([1, 2, 3]),
    duration_ms: 180_500,
  })
  expect(urls[0]).toBe(urls[1])
  expect(urls[2]).toEndWith("/300x300bb.jpg")
})

test("three failed image attempts bound total requests and retain exact duration", async () => {
  let calls = 0
  let cancelled = 0
  const result = await acquireCatalogArtwork(target, {
    retryDelayMs: 0,
    fetch: async () => {
      calls++
      return calls % 2
        ? search()
        : new Response(
            new ReadableStream({
              cancel() {
                cancelled++
              },
            }),
            { status: 429 },
          )
    },
  })
  expect(result).toEqual({ kind: "exhausted", duration_ms: 180_500 })
  expect(calls).toBe(6)
  expect(cancelled).toBe(3)
})

test("mismatch, ambiguous sparse identity and malformed catalog data never retry or download", async () => {
  for (const results of [
    [{ ...track, artistName: "Other" }],
    [{ ...track, trackTimeMillis: 181_001 }],
    [{ ...track, trackName: 42 }],
    [track, track],
  ]) {
    let calls = 0
    const result = await acquireCatalogArtwork(
      { ...target, duration_ms: results.length === 2 ? 0 : target.duration_ms },
      {
        retryDelayMs: 0,
        fetch: async () => {
          calls++
          return Response.json({ results })
        },
      },
    )
    expect(result.kind).toBe("unavailable")
    expect(calls).toBe(1)
  }
})

test("PNG negotiation keeps catalog policy shared without trusting image format", async () => {
  const urls: string[] = []
  await acquireCatalogArtwork(target, {
    format: "png",
    fetch: async (url) => {
      urls.push(String(url))
      return urls.length === 1 ? search() : new Response(new Uint8Array([1]))
    },
  })
  expect(urls[1]).toEndWith("/300x300bb.png")
})

test("redirects and foreign final URLs cancel their bodies without retrying", async () => {
  for (const mode of ["redirect", "foreign", "invalid"]) {
    let cancelled = 0
    let calls = 0
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled++
        },
      }),
      { status: mode === "redirect" ? 302 : 200 },
    )
    if (mode !== "redirect")
      Object.defineProperty(response, "url", {
        value: mode === "foreign" ? "https://example.com/" : "invalid",
      })
    const result = await acquireCatalogArtwork(target, {
      retryDelayMs: 0,
      fetch: async () => {
        calls++
        return response
      },
    })
    expect(result.kind).toBe("unavailable")
    expect(calls).toBe(1)
    expect(cancelled).toBe(1)
  }
})

test("image URLs reject credentials, nondefault ports, lookalikes and insecure schemes", () => {
  for (const url of [
    "http://is1.mzstatic.com/a",
    "https://mzstatic.com.evil.com/a",
    "https://user@is1.mzstatic.com/a",
    "https://is1.mzstatic.com:8080/a",
    "https://127.0.0.1/a",
  ])
    expect(allowedCatalogImageUrl(url)).toBeNull()
})

test("declared and streamed overflows release the body and reader lock", async () => {
  for (const declared of [true, false]) {
    let cancelled = 0
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(11))
        },
        cancel() {
          cancelled++
        },
      }),
      { headers: declared ? { "content-length": "11" } : {} },
    )
    expect(await readLimitedResponse(response, 10)).toBeNull()
    expect(cancelled).toBe(1)
    expect(response.body?.locked).toBe(false)
  }
})

test("abort interrupts a blocked body read, releases its lock, and never starts image work", async () => {
  const controller = new AbortController()
  let cancelled = 0
  let calls = 0
  const started = Promise.withResolvers<void>()
  const response = new Response(
    new ReadableStream({
      pull() {
        started.resolve()
      },
      cancel() {
        cancelled++
      },
    }),
  )
  const pending = acquireCatalogArtwork(target, {
    signal: controller.signal,
    fetch: async () => {
      calls++
      return response
    },
  })
  await started.promise
  controller.abort()
  expect((await pending).kind).toBe("aborted")
  expect(calls).toBe(1)
  expect(cancelled).toBe(1)
  expect(response.body?.locked).toBe(false)
})

test("an already aborted acquisition makes no requests", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  expect(
    (
      await acquireCatalogArtwork(target, {
        signal: controller.signal,
        fetch: async () => {
          calls++
          return search()
        },
      })
    ).kind,
  ).toBe("aborted")
  expect(calls).toBe(0)
})

test("the request deadline covers a blocked body and permits bounded recovery", async () => {
  let calls = 0
  let cancelled = 0
  const blocked = new Response(
    new ReadableStream({
      cancel() {
        cancelled++
      },
    }),
  )
  const result = await acquireCatalogArtwork(target, {
    retryDelayMs: 0,
    fetch: async () => {
      calls++
      if (calls === 1) return blocked
      return calls === 2 ? search() : new Response(new Uint8Array([1]))
    },
  })
  expect(result.kind).toBe("available")
  expect(calls).toBe(3)
  expect(cancelled).toBe(1)
  expect(blocked.body?.locked).toBe(false)
}, 10_000)

test("abort during backoff cancels recovery instead of consuming another attempt", async () => {
  const controller = new AbortController()
  let calls = 0
  const failed = Promise.withResolvers<void>()
  const result = acquireCatalogArtwork(target, {
    signal: controller.signal,
    fetch: async () => {
      calls++
      failed.resolve()
      return new Response(null, { status: 503 })
    },
  })
  await failed.promise
  controller.abort()
  expect((await result).kind).toBe("aborted")
  expect(calls).toBe(1)
})
