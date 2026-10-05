import { createCliRenderer, RGBA } from "@opentui/core"
import { PNG } from "pngjs"
import { kittyDisplayPng, writeGraphics } from "../kitty-graphics.ts"

const count = Number(process.env.MUSIC_ARTWORK_OUTPUT_COUNT ?? 24)
const png = new PNG({ width: 300, height: 169 })
let seed = 123
for (let index = 0; index < png.data.length; index++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  png.data[index] = index % 4 === 3 ? 255 : seed >>> 24
}
const pngBase64 = PNG.sync.write(png).toString("base64")

const renderer = await createCliRenderer({
  useThread: true,
  width: 140,
  height: 70,
  consoleMode: "disabled",
  useMouse: false,
  exitSignals: [],
  clearOnShutdown: false,
})

try {
  await renderer.idle()
  await Bun.sleep(100)
  const native = renderer as any
  native.lib.render(native.rendererPtr, true)
  await Bun.sleep(100)

  for (let iteration = 0; iteration < count; iteration++) {
    for (let y = 0; y < 70; y++) {
      for (let x = 0; x < 140; x++) {
        renderer.nextRenderBuffer.setCell(
          x,
          y,
          "R",
          RGBA.fromInts((x * 13 + iteration) % 256, (y * 17) % 256, 90),
          RGBA.fromInts(0, 0, 0),
        )
      }
    }
    native.lib.render(native.rendererPtr, true)
    await renderer.idle()
    if (
      !writeGraphics(renderer, kittyDisplayPng(pngBase64, 42, 110, 24, 24, 0))
    )
      throw new Error("OpenTUI did not accept the artwork transaction")
    await Bun.sleep(20)
  }
  await Bun.sleep(100)
} finally {
  renderer.destroy()
}
