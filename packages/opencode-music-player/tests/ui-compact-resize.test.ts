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
      id: "resize",
      uri: "music:resize",
      name: "Resize title",
      artists: "Resize artist",
      album: "Resize album",
      duration_ms: 1000,
      artwork: null,
    },
    is_playing: true,
    progress_ms: 0,
    fetched_at: Date.now(),
    shuffle: false,
    repeat: "off" as const,
    device: null,
  },
}

const contentRows = (frame: string) =>
  frame.split("\n").filter((line) => line.trim().length > 0)

test("CompactPlayer follows its allocated width across repeated resizes", async () => {
  const app = await testRender(
    () => CompactPlayer({ context: { theme } as any, state }),
    { width: 80, height: 4 },
  )

  const row = () =>
    app.renderer.root.findDescendantById(
      "music-compact-player",
    ) as BoxRenderable
  expect(row().onSizeChange).toBeFunction()
  const expectFluidRow = (width: number) => {
    expect(row().width).toBe(width)
    const declaredWidth = row().getLayoutNode().getWidth()
    expect(declaredWidth.value).toBe(100)
    expect(declaredWidth.unit).toBe(2) // Yoga's percent unit; point widths use 1.
  }

  try {
    const initial = await app.waitForFrame((frame) =>
      frame.includes("Resize artist"),
    )
    expect(initial).toContain("⏸")
    expect(initial).toContain("Resize title - Resize artist")
    expect(contentRows(initial)).toHaveLength(1)
    expectFluidRow(80)

    app.resize(10, 4)
    await app.waitFor(() => row().width === 10)
    expectFluidRow(10)
    const narrow = await app.waitForFrame((frame) => frame.includes("Resiz…"))
    expect(narrow).toContain("⏸")
    expect(narrow).not.toContain("Resize artist")
    expect(contentRows(narrow)).toHaveLength(1)

    app.resize(80, 4)
    await app.waitFor(() => row().width === 80)
    expectFluidRow(80)
    const wide = await app.waitForFrame((frame) =>
      frame.includes("Resize artist"),
    )
    expect(wide).toContain("Resize title - Resize artist")
    expect(contentRows(wide)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})
