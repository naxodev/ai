/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Show, createSignal } from "solid-js"
import { testRender, useRenderer } from "@opentui/solid"
import { AlbumArtwork } from "../artwork.tsx"

test("remounting the same native artwork preserves its image and placement", async () => {
  const writes: string[] = []
  let remount = () => {}
  let unmount = () => {}
  const artwork = {
    id: "stable-cover",
    png_base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    accent: "#7aa2f7",
    cells: [[{ upper: "#7aa2f7", lower: "#1a1b26" }]],
  }
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      const contextRenderer = new Proxy(renderer as any, {
        get(target, property) {
          if (property === "capabilities") return { kitty_graphics: true }
          if (property === "stdout") return {}
          if (property === "realStdoutWrite")
            return (data: string) => {
              writes.push(data)
              return true
            }
          const value = Reflect.get(target, property)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
      const [stage, setStage] = createSignal(0)
      remount = () => setStage(1)
      unmount = () => setStage(2)
      const context = { renderer: contextRenderer } as any
      return (
        <Show when={stage() < 2} fallback={<box width={24} height={12} />}>
          <Show
            when={stage() === 0}
            fallback={<AlbumArtwork context={context} artwork={artwork} />}
          >
            <AlbumArtwork context={context} artwork={artwork} />
          </Show>
        </Show>
      )
    },
    { width: 40, height: 20 },
  )

  try {
    await app.waitFor(() => writes.some((write) => write.includes("a=T")))
    writes.length = 0
    remount()
    await Bun.sleep(50)
    expect(writes.some((write) => write.includes("a=T"))).toBeFalse()
    expect(writes.some((write) => write.includes("a=d,d=I"))).toBeFalse()
    unmount()
    await app.waitFor(() => writes.some((write) => write.includes("a=d,d=I")))
    expect(writes.filter((write) => write.includes("a=d,d=I"))).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})
