/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { SidebarPlayer } from "../ui.tsx"
import { emptyPlayer } from "../types.ts"

const theme = {
  text: {
    base: "white",
    muted: "gray",
    action: { primary: { base: "blue" } },
    feedback: { error: { base: "red" } },
  },
  border: { base: "gray" },
  background: {
    raised: { base: "black" },
    action: { primary: { base: "black" } },
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
