/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Show, createSignal } from "solid-js"
import { testRender, useRenderer } from "@opentui/solid"
import type { CliRenderer } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { AlbumArtwork } from "../artwork.tsx"

const artwork = {
  id: "resize-cover",
  png_base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  accent: "#7aa2f7",
  cells: [[{ upper: "#7aa2f7", lower: "#1a1b26" }]],
}

function recordingContext(
  renderer: CliRenderer,
  writes: string[],
  resolution = () =>
    ({
      width: renderer.terminalWidth * 10,
      height: renderer.terminalHeight * 20,
    }) as { width: number; height: number } | null,
  write = (value: string) => {
    writes.push(value)
  },
): Plugin.Context {
  return {
    renderer: new Proxy(renderer, {
      get(target, property) {
        if (property === "capabilities") return { kitty_graphics: true }
        if (property === "resolution") return resolution()
        if (property === "writeOut")
          return (value: string) => {
            write(value)
            return true
          }
        const value: unknown = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    }),
  } as Plugin.Context
}

test("resize removes the terminal's stale placement before any deferred frame", async () => {
  const writes: string[] = []
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      renderer.start()
      return (
        <box position="absolute" right={2} top={5} width={24} height={12}>
          <AlbumArtwork
            context={recordingContext(renderer, writes)}
            artwork={artwork}
          />
        </box>
      )
    },
    { width: 80, height: 30 },
  )

  try {
    await app.waitFor(() => writes.some((value) => value.includes("a=T")))
    for (const width of [100, 80, 100]) {
      writes.length = 0
      app.resize(width, 30)
      // The terminal can reflow native images independently of Yoga. Remove
      // the old placement now, not when the renderer eventually becomes idle.
      expect(writes.some((value) => value.includes("a=d,d=i"))).toBeTrue()
      expect(writes.some((value) => /a=[Tp],/.test(value))).toBeFalse()
      await app.waitFor(() => writes.some((value) => value.includes("a=p")))
      const placement = writes.find((value) => value.includes("a=p"))!
      expect(placement).toContain(`\x1b[6;${width - 24 - 2 + 1}H`)
      expect(writes.some((value) => value.includes("a=T"))).toBeFalse()
    }
  } finally {
    app.renderer.destroy()
  }
})

test("live rendering must not postpone native artwork until animation stops", async () => {
  const writes: string[] = []
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      renderer.start()
      return (
        <box position="absolute" left={40} top={5} width={24} height={12}>
          <AlbumArtwork
            context={recordingContext(renderer, writes)}
            artwork={artwork}
          />
        </box>
      )
    },
    { width: 80, height: 30 },
  )
  try {
    await app.waitFor(() => writes.some((value) => value.includes("a=T")))
    expect(app.renderer.isRunning).toBeTrue()
    expect(writes.find((value) => value.includes("a=T"))).toContain(
      "\x1b[6;41H",
    )
  } finally {
    app.renderer.destroy()
  }
})

test("a sidebar remounted after layout never paints artwork at its unlaid-out origin", async () => {
  const writes: string[] = []
  let remount = () => {}
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      const context = recordingContext(renderer, writes)
      const [stage, setStage] = createSignal(false)
      remount = () => setStage(true)
      return (
        <Show
          when={!stage()}
          fallback={
            <box position="absolute" left={45} top={5} width={24} height={12}>
              <AlbumArtwork context={context} artwork={artwork} />
            </box>
          }
        >
          <box position="absolute" left={40} top={5} width={24} height={12}>
            <AlbumArtwork context={context} artwork={artwork} />
          </box>
        </Show>
      )
    },
    { width: 80, height: 30 },
  )

  try {
    await app.waitFor(() => writes.some((value) => value.includes("a=T")))
    writes.length = 0
    const replaceAfterLayout = () => {
      app.renderer.removePostProcessFn(replaceAfterLayout)
      remount()
    }
    app.renderer.addPostProcessFn(replaceAfterLayout)
    await app.renderOnce()
    await app.waitFor(() => writes.some((value) => value.includes("a=p")))
    for (const command of writes.filter((value) => /a=[Tp],/.test(value)))
      expect(command).toContain("\x1b[6;46H")
  } finally {
    app.renderer.destroy()
  }
})

test("resize waits for new pixel metrics and restores even an unchanged slot", async () => {
  const writes: string[] = []
  let resolution: { width: number; height: number } | null = {
    width: 800,
    height: 600,
  }
  const app = await testRender(
    () => {
      const context = recordingContext(useRenderer(), writes, () => resolution)
      return (
        <box position="absolute" left={40} top={5} width={24} height={12}>
          <AlbumArtwork context={context} artwork={artwork} />
        </box>
      )
    },
    { width: 80, height: 30 },
  )
  try {
    await app.waitFor(() => writes.some((value) => value.includes("a=T")))
    await app.waitForFrame((frame) => !frame.includes("▀"))
    writes.length = 0
    resolution = null
    app.resize(80, 35)
    await app.waitForFrame((frame) => frame.includes("▀"))
    expect(writes.some((value) => value.includes("a=d,d=i"))).toBeTrue()
    expect(writes.some((value) => value.includes("a=d,d=I"))).toBeFalse()
    expect(writes.some((value) => /a=[Tp],/.test(value))).toBeFalse()
    resolution = { width: 800, height: 700 }
    await app.waitFor(() => writes.some((value) => value.includes("a=p")))
    expect(writes.find((value) => value.includes("a=p"))).toContain(
      "\x1b[6;41H",
    )
    expect(writes.some((value) => value.includes("a=T"))).toBeFalse()
    await app.waitForFrame((frame) => !frame.includes("▀"))
  } finally {
    app.renderer.destroy()
  }
})

test("hides the native image when its slot stops rendering", async () => {
  const writes: string[] = []
  let hide = () => {}
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      const [visible, setVisible] = createSignal(true)
      hide = () => setVisible(false)
      return (
        <box
          position="absolute"
          left={40}
          top={5}
          width={24}
          height={12}
          visible={visible()}
        >
          <AlbumArtwork
            context={recordingContext(renderer, writes)}
            artwork={artwork}
          />
        </box>
      )
    },
    { width: 80, height: 30 },
  )
  try {
    await app.waitFor(() => writes.some((value) => value.includes("a=T")))
    writes.length = 0
    hide()
    await app.renderOnce()
    await app.waitFor(() => writes.some((value) => value.includes("a=d,d=i")))
    expect(writes.some((value) => /a=[Tp],/.test(value))).toBeFalse()
  } finally {
    app.renderer.destroy()
  }
})

test("hidden artwork retries a failed delete instead of leaving the image visible", async () => {
  const writes: string[] = []
  let hide = () => {}
  let failDelete = false
  let failedDeletes = 0
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      const [visible, setVisible] = createSignal(true)
      hide = () => {
        failDelete = true
        setVisible(false)
      }
      const context = recordingContext(renderer, writes, undefined, (value) => {
        if (failDelete && value.includes("a=d,d=i")) {
          failDelete = false
          failedDeletes++
          throw new Error("controlled delete failure")
        }
        writes.push(value)
      })
      return (
        <box
          position="absolute"
          left={40}
          top={5}
          width={24}
          height={12}
          visible={visible()}
        >
          <AlbumArtwork context={context} artwork={artwork} />
        </box>
      )
    },
    { width: 80, height: 30 },
  )
  try {
    await app.waitFor(() => writes.some((value) => value.includes("a=T")))
    writes.length = 0
    hide()
    await app.renderOnce()
    await app.renderOnce()
    await app.renderOnce()
    expect(failedDeletes).toBe(1)
    expect(writes.some((value) => value.includes("a=d,d=i"))).toBeTrue()
    expect(writes.some((value) => /a=[Tp],/.test(value))).toBeFalse()
  } finally {
    app.renderer.destroy()
  }
})

test("changing covers while the sidebar shrinks removes the previous image", async () => {
  const writes: string[] = []
  let change = () => {}
  let restore = () => {}
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      const context = recordingContext(renderer, writes)
      const [width, setWidth] = createSignal(24)
      const [cover, setCover] = createSignal(artwork)
      restore = () => setWidth(24)
      change = () => {
        setWidth(16)
        setCover({ ...artwork, id: "next-cover" })
      }
      return (
        <box position="absolute" left={40} top={5} width={width()} height={12}>
          <AlbumArtwork context={context} artwork={cover()} />
        </box>
      )
    },
    { width: 80, height: 30 },
  )
  try {
    await app.waitFor(() => writes.some((value) => value.includes("a=T")))
    writes.length = 0
    change()
    await app.renderOnce()
    await app.renderOnce()
    expect(writes.some((value) => value.includes("a=d,d=i"))).toBeTrue()
    expect(writes.some((value) => /a=[Tp],/.test(value))).toBeFalse()
    writes.length = 0
    restore()
    await app.waitFor(() => writes.some((value) => value.includes("a=T")))
    expect(writes.find((value) => value.includes("a=T"))).toContain(
      "\x1b[6;41H",
    )
  } finally {
    app.renderer.destroy()
  }
})

test("hides the native image when the sidebar has no room for it", async () => {
  const writes: string[] = []
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      return (
        <box position="absolute" left={0} top={5} width={16} height={12}>
          <AlbumArtwork
            context={recordingContext(renderer, writes)}
            artwork={artwork}
          />
        </box>
      )
    },
    { width: 80, height: 30 },
  )
  try {
    await app.renderOnce()
    await app.renderer.idle()
    await app.renderOnce()
    expect(writes.some((value) => /a=[Tp],/.test(value))).toBeFalse()
  } finally {
    app.renderer.destroy()
  }
})

test("hides the native image when it overflows its clipping container", async () => {
  const writes: string[] = []
  const app = await testRender(
    () => {
      const renderer = useRenderer()
      return (
        <box
          position="absolute"
          left={40}
          top={0}
          width={24}
          height={16}
          overflow="hidden"
          flexDirection="column"
        >
          <box height={10} />
          <AlbumArtwork
            context={recordingContext(renderer, writes)}
            artwork={artwork}
          />
        </box>
      )
    },
    { width: 80, height: 30 },
  )
  try {
    await app.renderOnce()
    await app.renderer.idle()
    await app.renderOnce()
    expect(writes.some((value) => /a=[Tp],/.test(value))).toBeFalse()
  } finally {
    app.renderer.destroy()
  }
})
