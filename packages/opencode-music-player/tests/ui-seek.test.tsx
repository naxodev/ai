/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { BoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore } from "solid-js/store"
import { CompactPlayer, SidebarPlayer } from "../ui.tsx"

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

const state = {
  loading: false,
  error: null,
  player: {
    track: {
      id: "seek",
      uri: "music:seek",
      name: "Seek title",
      artists: "Seek artist",
      album: "Seek album",
      duration_ms: 100_000,
      artwork: null,
    },
    is_playing: false,
    progress_ms: 0,
    fetched_at: Date.now(),
    shuffle: false,
    repeat: "off" as const,
    device: null,
  },
}

test("CompactPlayer seeks within its local eighty-percent region", async () => {
  const seeks: number[] = []
  let playPauses = 0
  let bubbled = 0
  const app = await testRender(
    () => {
      const [reactiveState, setReactiveState] = createStore(state)
      return (
        <box paddingLeft={3} onMouseDown={() => bubbled++}>
          <CompactPlayer
            context={{ theme } as any}
            state={reactiveState}
            onPlayPause={() => {
              playPauses++
              setReactiveState("player", "is_playing", (playing) => !playing)
            }}
            onSeek={(position) => seeks.push(position)}
          />
        </box>
      )
    },
    { width: 100, height: 4 },
  )
  const row = app.renderer.root.findDescendantById(
    "music-compact-player",
  ) as BoxRenderable

  try {
    await app.waitFor(() => row.width === 97)
    const seekWidth = 78
    await app.mockMouse.click(row.x + 1, row.y)
    expect(playPauses).toBe(1)
    expect(seeks).toHaveLength(0)
    await app.waitForFrame((frame) => frame.includes("⏸"))

    await app.mockMouse.click(row.x, row.y)
    await app.mockMouse.click(row.x + Math.floor((seekWidth - 1) / 2), row.y)
    await app.mockMouse.click(row.x + seekWidth - 1, row.y)
    expect(seeks).toEqual([0, 49_351, 100_000])
    expect(bubbled).toBe(0)

    await app.mockMouse.click(row.x + seekWidth, row.y)
    await app.mockMouse.click(row.x, row.y, 2)
    expect(seeks).toHaveLength(3)
    expect(bubbled).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("SidebarPlayer seeks through its visible progress bar", async () => {
  const seeks: number[] = []
  const app = await testRender(
    () => (
      <SidebarPlayer
        context={{ theme } as any}
        state={state}
        onPlayPause={() => {}}
        onNext={() => {}}
        onPrev={() => {}}
        onSeek={(position) => seeks.push(position)}
      />
    ),
    { width: 40, height: 30 },
  )
  const bar = app.renderer.root.findDescendantById(
    "music-sidebar-seek",
  ) as BoxRenderable

  try {
    await app.waitFor(() => bar.width === 24)
    await app.mockMouse.click(bar.x + 12, bar.y)
    expect(seeks).toEqual([52_174])
  } finally {
    app.renderer.destroy()
  }
})
