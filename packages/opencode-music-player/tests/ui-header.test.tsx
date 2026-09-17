/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore } from "solid-js/store"
import { SidebarPlayer, type UiState } from "../ui.tsx"
import { emptyPlayer } from "../types.ts"

const theme = {
  text: {
    default: "white",
    subdued: "gray",
    action: { primary: { default: "blue" } },
    feedback: { error: { default: "red" } },
  },
  border: { default: "gray" },
  background: {
    surface: { offset: "black" },
    action: { primary: { default: "black" } },
  },
}
const track = {
  id: "song",
  uri: "music:song",
  name: "Current song",
  artists: "Current artist",
  album: "Current album",
  duration_ms: 100_000,
  artwork: null,
}

function buttonFor(root: Renderable, glyph: string): Renderable {
  const pending = [...root.getChildren()]
  while (pending.length) {
    const child = pending.shift()!
    if (child instanceof TextRenderable && child.plainText.includes(glyph))
      return child.parent!
    pending.push(...child.getChildren())
  }
  throw new Error(`Missing visible transport glyph: ${glyph}`)
}

test("sidebar feedback transitions recover without redundant playback headers", async () => {
  const [state, setState] = createStore<UiState>({
    loading: true,
    error: null,
    player: emptyPlayer(),
  })
  const app = await testRender(
    () => (
      <SidebarPlayer
        context={{ theme } as any}
        state={state}
        onPlayPause={() => setState("player", "is_playing", (value) => !value)}
        onNext={() => {}}
        onPrev={() => {}}
        onSeek={() => {}}
      />
    ),
    { width: 40, height: 40 },
  )
  try {
    await app.waitForFrame((frame) => frame.includes("Syncing…"))
    setState("loading", false)
    await app.waitForFrame(
      (frame) =>
        frame.includes("Nothing playing") && !frame.includes("Syncing…"),
    )
    setState("error", "Provider disconnected")
    await app.waitForFrame((frame) => frame.includes("Provider disconnected"))
    setState({
      error: null,
      player: { ...emptyPlayer(), track, is_playing: false },
    })
    const paused = await app.waitForFrame(
      (frame) =>
        frame.includes("Current song") &&
        frame.includes("▶") &&
        !frame.includes("Provider disconnected"),
    )
    expect(paused).toContain("Current artist")
    const button = buttonFor(app.renderer.root, "▶")
    await app.mockMouse.click(button.x, button.y)
    const playing = await app.waitForFrame((frame) => frame.includes("⏸"))
    for (const frame of [paused, playing]) {
      expect(frame).not.toContain("Now playing")
      expect(frame.split("\n").map((line) => line.trim())).not.toContain(
        "playing",
      )
      expect(frame.split("\n").map((line) => line.trim())).not.toContain(
        "paused",
      )
    }
    await app.mockMouse.click(button.x, button.y)
    await app.waitForFrame(
      (frame) => frame.includes("▶") && !frame.includes("⏸"),
    )
  } finally {
    app.renderer.destroy()
  }
})

for (const width of [26, 40])
  test(`transport targets fit a ${width}-cell sidebar and route edge clicks`, async () => {
    const calls: string[] = []
    const state: UiState = {
      loading: false,
      error: null,
      player: { ...emptyPlayer(), track },
    }
    const app = await testRender(
      () => (
        <SidebarPlayer
          context={{ theme } as any}
          state={state}
          onPlayPause={() => {
            calls.push("toggle")
          }}
          onPrev={() => {
            calls.push("previous")
          }}
          onNext={() => {
            calls.push("next")
          }}
          onSeek={() => {
            calls.push("seek")
          }}
        />
      ),
      { width, height: 40 },
    )
    try {
      await app.waitForFrame(
        (frame) =>
          frame.includes("⏮") && frame.includes("▶") && frame.includes("⏭"),
      )
      const previous = buttonFor(app.renderer.root, "⏮")
      const toggle = buttonFor(app.renderer.root, "▶")
      const next = buttonFor(app.renderer.root, "⏭")
      expect(previous.width).toBeGreaterThanOrEqual(6)
      expect(next.width).toBe(previous.width)
      expect(toggle.width).toBeGreaterThanOrEqual(10)
      expect(toggle.width).toBeGreaterThan(previous.width)
      expect(previous.x).toBeGreaterThanOrEqual(0)
      expect(next.x + next.width).toBeLessThanOrEqual(width)
      expect(previous.x + previous.width).toBeLessThan(toggle.x)
      expect(toggle.x + toggle.width).toBeLessThan(next.x)
      for (const [button, action] of [
        [previous, "previous"],
        [toggle, "toggle"],
        [next, "next"],
      ] as const) {
        expect(button.height).toBeGreaterThanOrEqual(2)
        await app.mockMouse.click(button.x, button.y)
        await app.mockMouse.click(
          button.x + button.width - 1,
          button.y + button.height - 1,
        )
        expect(calls.splice(0)).toEqual([action, action])
      }
      await app.mockMouse.click(previous.x + previous.width, previous.y)
      await app.mockMouse.click(toggle.x + toggle.width, toggle.y)
      expect(calls).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })
