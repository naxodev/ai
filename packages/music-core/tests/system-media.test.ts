import { beforeEach, describe, expect, test } from "bun:test"
import { resetClock, trackKey } from "../clock.ts"
import { run } from "../run.ts"
import {
  bundleLabel,
  createSystemMedia,
  effectiveBundle,
  resetMediaBackend,
} from "../system-media.ts"

beforeEach(() => {
  resetClock()
  resetMediaBackend()
})

describe("trackKey", () => {
  // Providers without content ids still need a stable playback key.
  test("uses stable metadata when the provider has no content identifier", () => {
    expect(trackKey("Song", "Artist", "")).toBe("Song\0Artist")
    expect(trackKey("Song", "Artist", "provider-id")).toBe("provider-id")
  })
})

describe("bundleLabel / effectiveBundle", () => {
  // Device label must name the real player for the host UI.
  test.each([
    ["com.Spotify.client", "Spotify"],
    ["com.apple.Music", "Apple Music"],
    ["com.google.Chrome", "Chrome"],
    [null, "System media"],
  ])("labels %s as %s", (bundle, expected) => {
    expect(bundleLabel(bundle)).toBe(expected)
  })

  // Prefer parent over WebKit GPU so Browser/Kaset labels stay truthful.
  test("maps known bundles and prefers parent over WebKit GPU", () => {
    expect(bundleLabel("com.Spotify.client")).toBe("Spotify")

    const resolved = effectiveBundle({
      bundleIdentifier: "com.apple.WebKit.GPU",
      parentApplicationBundleIdentifier: "app.Kaset.desktop",
    })
    expect(resolved).toBe("app.Kaset.desktop")
    expect(bundleLabel(resolved)).toBe("Kaset")

    expect(
      bundleLabel(
        effectiveBundle({
          bundleIdentifier: "com.apple.WebKit.GPU",
          parentApplicationBundleIdentifier: null,
        }),
      ),
    ).toBe("Browser")
  })
})

describe("media command boundaries", () => {
  // A wedged provider must not hang the poll loop forever.
  test("default run times out with a stable timed_out result", async () => {
    const result = await run(["sleep", "1"], 50)

    expect(result).toEqual({
      ok: false,
      err: "command timed out after 50ms",
      timed_out: true,
    })
  })

  // Preferred media-control failure must fall through to nowplaying-cli.
  test("keeps the current track visible through the fallback when the preferred provider times out", async () => {
    const providers: string[] = []
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => true,
      run: async ([provider]) => {
        providers.push(provider!)
        if (provider === "media-control") {
          return { ok: false, err: "command timed out", timed_out: true }
        }
        return {
          ok: true,
          out: JSON.stringify({
            title: "Fallback Song",
            artist: "Fallback Artist",
            album: "",
            duration: 180,
            elapsedTime: 30,
            playbackRate: 1,
            isPlaying: true,
          }),
        }
      },
    })

    const player = await backend.player()

    expect(providers).toEqual(["media-control", "nowplaying-cli"])
    expect(player?.track?.name).toBe("Fallback Song")
    expect(player?.track?.artists).toBe("Fallback Artist")
    expect(player?.is_playing).toBe(true)
  })

  // Transport argv maps must stay stable for both backends.
  test("play maps to the preferred backend argv", async () => {
    const calls: string[][] = []
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (cmd) => {
        calls.push(cmd)
        return { ok: true, out: "" }
      },
    })

    await backend.play()
    expect(calls).toEqual([["media-control", "play"]])
  })
})
