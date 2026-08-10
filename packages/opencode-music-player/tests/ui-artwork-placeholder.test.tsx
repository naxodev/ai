/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SidebarPlayer } from "../ui.tsx"
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

test("SidebarPlayer reserves artwork space while a cover loads", async () => {
  const state = {
    loading: false,
    error: null,
    player: {
      ...emptyPlayer(),
      track: {
        id: "song",
        uri: "system:song",
        name: "Song",
        artists: "Artist",
        album: "Album",
        duration_ms: 180_000,
        artwork: null,
        artwork_loading: true,
      },
    },
  }
  const app = await testRender(
    () => (
      <SidebarPlayer
        context={{ theme } as any}
        state={state}
        onPlayPause={() => {}}
        onNext={() => {}}
        onPrev={() => {}}
        onSeek={() => {}}
      />
    ),
    { width: 40, height: 30 },
  )

  try {
    const frame = await app.waitForFrame((value) =>
      value.includes("Loading artwork…"),
    )
    expect(frame).toContain("Song")
    expect(frame).toContain("●")
  } finally {
    app.renderer.destroy()
  }
})

test("SidebarPlayer mounts its artwork placeholder without a track", async () => {
  const state = { loading: false, error: null, player: emptyPlayer() }
  const app = await testRender(
    () => (
      <SidebarPlayer
        context={{ theme } as any}
        state={state}
        onPlayPause={() => {}}
        onNext={() => {}}
        onPrev={() => {}}
        onSeek={() => {}}
      />
    ),
    { width: 40, height: 30 },
  )

  try {
    const frame = await app.waitForFrame((value) =>
      value.includes("Nothing playing"),
    )
    expect(frame).not.toContain("Artwork unavailable")
  } finally {
    app.renderer.destroy()
  }
})
