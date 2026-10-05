/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { PNG } from "pngjs"
import { AlbumArtwork } from "../artwork.tsx"
import type { Plugin } from "@opencode/plugin/tui"

for (const [
  width,
  height,
  columns,
  rows,
  screenX,
  screenY,
  terminalPixelsHigh,
  terminalPixelsWide,
] of [
  [80, 40, 24, 0, 0, 3, 400, 400],
  [40, 80, 0, 12, 6, 0, 400, 400],
  [80, 80, 0, 12, 2, 0, 320, 400],
  [300, 1, 0, 0, 0, 0, 240, 240],
  [1, 300, 0, 0, 0, 0, 240, 240],
] as const) {
  test(`native ${width}×${height} artwork fits ${terminalPixelsHigh / 20}px-high cells without distortion`, async () => {
    const image = new PNG({ width, height })
    image.data.fill(255)
    const writes: string[] = []
    let resolution: { width: number; height: number } | null = null
    const app = await testRender(
      () => {
        const renderer = useRenderer()
        const contextRenderer = new Proxy(renderer, {
          get(target, property) {
            if (property === "capabilities") return { kitty_graphics: true }
            if (property === "resolution") return resolution
            if (property === "writeOut")
              return (value: string) => {
                writes.push(value)
                return true
              }
            const value: unknown = Reflect.get(target, property)
            return typeof value === "function" ? value.bind(target) : value
          },
        })
        return (
          <AlbumArtwork
            context={{ renderer: contextRenderer } as Plugin.Context}
            artwork={{
              id: `rectangle-${width}-${height}`,
              png_base64: PNG.sync.write(image).toString("base64"),
              accent: "#ffffff",
              cells: [[{ upper: "#ffffff", lower: "#ffffff" }]],
            }}
          />
        )
      },
      { width: 40, height: 20 },
    )
    try {
      await app.renderOnce()
      expect(writes.some((value) => value.includes("a=T"))).toBe(false)
      expect(app.captureCharFrame()).toContain("▀")
      // Pixel metrics arrive asynchronously. Keep the text fallback until the
      // limiting axis can be selected safely, then paint on the next frame.
      resolution = { width: terminalPixelsWide, height: terminalPixelsHigh }
      await app.renderOnce()
      if (columns === 0 && rows === 0) {
        await app.renderer.idle()
        await app.renderOnce()
        expect(writes.some((value) => value.includes("a=T"))).toBe(false)
        expect(app.captureCharFrame()).toContain("▀")
        return
      }
      await app.waitFor(() => writes.some((value) => value.includes("a=T")))
      await app.waitForFrame((frame) => !frame.includes("▀"))
      const command = writes.find((value) => value.includes("a=T"))!
      const encodedColumns = Number(command.match(/,c=(\d+)/)?.[1] ?? 0)
      const encodedRows = Number(command.match(/,r=(\d+)/)?.[1] ?? 0)
      expect([encodedColumns, encodedRows]).toEqual([columns, rows])
      expect(command).toContain(`\x1b[${screenY + 1};${screenX + 1}H`)
      // Ghostty computes both dimensions directly if c and r are present.
      // With one omitted, it preserves the image ratio in physical pixels.
      const cellHeight = terminalPixelsHigh / 20
      const displayedWidth = encodedColumns
        ? encodedColumns * 10
        : (encodedRows * cellHeight * width) / height
      const displayedHeight = encodedRows
        ? encodedRows * cellHeight
        : (encodedColumns * 10 * height) / width
      expect(displayedWidth / displayedHeight).toBeCloseTo(width / height)
      expect(displayedWidth).toBeLessThanOrEqual(240)
      expect(displayedHeight).toBeLessThanOrEqual(12 * cellHeight)
      writes.length = 0
      resolution = null
      await app.renderOnce()
      await app.waitForFrame((frame) => frame.includes("▀"))
      expect(writes.some((value) => value.includes("a=d,d=I"))).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })
}
