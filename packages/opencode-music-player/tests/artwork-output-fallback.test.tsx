/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { AlbumArtwork } from "../artwork.tsx"

const artwork = {
  id: "fallback-cover",
  png_base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  accent: "#7aa2f7",
  cells: [[{ upper: "#7aa2f7", lower: "#1a1b26" }]],
}

for (const [description, writeOut] of [
  ["is unavailable", undefined],
  [
    "throws",
    () => {
      throw new Error("output failed")
    },
  ],
] as const) {
  test(`native artwork text fallback remains visible when the output hook ${description}`, async () => {
    const app = await testRender(
      () => {
        const renderer = useRenderer()
        const contextRenderer = new Proxy(renderer, {
          get(target, property) {
            if (property === "capabilities") return { kitty_graphics: true }
            if (property === "resolution") return { width: 400, height: 400 }
            if (property === "writeOut") return writeOut
            const value: unknown = Reflect.get(target, property)
            return typeof value === "function" ? value.bind(target) : value
          },
        })
        return (
          <AlbumArtwork
            context={{ renderer: contextRenderer } as any}
            artwork={artwork}
          />
        )
      },
      { width: 40, height: 20 },
    )

    try {
      await app.renderOnce()
      await Bun.sleep(50)
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("▀")
    } finally {
      app.renderer.destroy()
    }
  })
}
