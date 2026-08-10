/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { BoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { CompactPlayer } from "../ui.tsx"

const theme = {
  text: {
    default: "white",
    subdued: "gray",
    action: { primary: { default: "blue" } },
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
  let bubbled = 0
  const app = await testRender(
    () => (
      <box paddingLeft={3} onMouseDown={() => bubbled++}>
        <CompactPlayer
          context={{ theme } as any}
          state={state}
          onSeek={(position) => seeks.push(position)}
        />
      </box>
    ),
    { width: 100, height: 4 },
  )
  const row = app.renderer.root.findDescendantById(
    "music-compact-player",
  ) as BoxRenderable

  try {
    await app.waitFor(() => row.width === 97)
    const seekWidth = 78
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
