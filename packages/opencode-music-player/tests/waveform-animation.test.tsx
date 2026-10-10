/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { Waveform, type PlayerPresentationSource } from "../waveform.tsx"
import type { PlayerState } from "../types.ts"

test("generated bars stay labeled as animation so they cannot be mistaken for measured audio", async () => {
  let current: PlayerState | null = {
    is_playing: true,
    progress_ms: 1_000,
    fetched_at: Date.now(),
    shuffle: false,
    repeat: "off",
    device: null,
    track: {
      id: "fixture",
      uri: "fixture",
      name: "Fixture",
      artists: "Artist",
      album: "Album",
      duration_ms: 180_000,
      artwork: null,
    },
  }
  const listeners = new Set<(player: PlayerState | null) => void>()
  const source: PlayerPresentationSource = {
    current: () => current,
    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => listeners.delete(listener)
    },
  }
  const app = await testRender(
    () => (
      <Waveform
        theme={{ text: { muted: RGBA.fromHex("#888888") } }}
        source={source}
        bars={24}
        variant="hero"
      />
    ),
    { width: 30, height: 4 },
  )
  try {
    const playing = await app.waitForFrame(
      (value) => value.includes("Animation") && /[▁▂▃▄▅▆▇█]/.test(value),
    )
    expect(playing).toContain("Animation")
    current = null
    for (const listener of listeners) listener(current)
    const cleared = await app.waitForFrame(
      (value) => !value.includes("Animation") && !/[▁▂▃▄▅▆▇█]/.test(value),
    )
    expect(cleared.trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
  expect(listeners.size).toBe(0)
})
