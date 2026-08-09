import { beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { resetClock, syncFromSample, trackKey } from "../clock.ts"
import { mergePlayer } from "../reconcile.ts"
import { run, startLineStream } from "../run.ts"
import {
  bundleLabel,
  createSystemMedia,
  effectiveBundle,
  resetMediaBackend,
  type SystemMediaDependencies,
} from "../system-media.ts"
import type { LineStreamCallbacks } from "../run.ts"

class FakeLineStreamProcess extends EventEmitter {
  stdout = new EventEmitter()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killCalls = 0

  kill() {
    this.killCalls++
  }
}

type FakeSource = {
  callbacks: LineStreamCallbacks
  disposed: number
}

function createStreamFakes() {
  const sources: FakeSource[] = []
  const timers: Array<{
    callback: () => void
    delayMs: number
    active: boolean
  }> = []
  const timer = (callback: () => void, delayMs: number) => {
    const entry = { callback, delayMs, active: true }
    timers.push(entry)
    return entry as unknown as ReturnType<typeof setTimeout>
  }
  const clearTimer = (entry: ReturnType<typeof setTimeout>) => {
    ;(entry as unknown as { active: boolean }).active = false
  }
  const backend = createSystemMedia({
    detectBackend: () => "media-control",
    hasNowPlayingCli: () => false,
    run: async () => ({ ok: true, out: "" }),
    startLineStream: (_cmd, callbacks) => {
      const source = { callbacks, disposed: 0 }
      sources.push(source)
      return () => {
        source.disposed++
      }
    },
    setRetryTimer: timer,
    clearRetryTimer: clearTimer,
  })
  return {
    backend,
    sources,
    timers,
    runNextTimer() {
      const next = timers.find((entry) => entry.active)
      if (!next) throw new Error("no active retry timer")
      next.active = false
      next.callback()
    },
  }
}

beforeEach(() => {
  resetClock()
  resetMediaBackend()
})

describe("trackKey", () => {
  // Providers without content ids still need a stable playback key.
  test("uses stable metadata when the provider has no content identifier", () => {
    expect(trackKey("Song", "Artist", "")).toBe("Song\0Artist")
    expect(trackKey("Song", "Artist", "provider-id")).toBe(
      "provider-id\0Song\0Artist",
    )
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
  test("keeps the raw provider id separate from the playback clock key", async () => {
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async () => ({
        ok: true,
        out: JSON.stringify({
          contentItemIdentifier: "provider-id",
          title: "Song",
          artist: "Artist",
          duration: 180,
          elapsedTimeNow: 10,
          playing: false,
        }),
      }),
    })

    const state = await backend.player()

    expect(state?.track?.id).toBe("provider-id")
    expect(
      trackKey(state!.track!.name, state!.track!.artists, state!.track!.id),
    ).toBe("provider-id\0Song\0Artist")
  })

  test("a blank title sample keeps provider identity for host reconciliation", async () => {
    const samples = [
      {
        contentItemIdentifier: "provider-id",
        title: "Song",
        artist: "Artist",
        duration: 180,
        elapsedTimeNow: 10,
        playing: false,
      },
      {
        contentItemIdentifier: "provider-id",
        title: "",
        artist: "",
        duration: 180,
        elapsedTimeNow: 10,
        playing: false,
      },
    ]
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async () => ({ ok: true, out: JSON.stringify(samples.shift()) }),
    })

    const initial = await backend.player()
    const incomplete = await backend.player()
    const reconciled = mergePlayer(initial, incomplete)

    expect(incomplete?.track?.id).toBe("provider-id")
    expect(reconciled?.track?.name).toBe("Song")
    expect(reconciled?.track?.artists).toBe("Artist")
    expect(reconciled?.progress_ms).toBe(10_000)
    expect(reconciled?.is_playing).toBe(false)
  })

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

  test("failed transport commands do not corrupt the sampled clock", async () => {
    const sample = {
      contentItemIdentifier: "provider-id",
      title: "Song",
      artist: "Artist",
      duration: 180,
      elapsedTimeNow: 10,
      playing: false,
    }
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) =>
        command[1] === "get"
          ? { ok: true, out: JSON.stringify(sample) }
          : {
              ok: false,
              err: "provider rejected command",
              timed_out: false,
            },
    })
    await backend.player()

    await expect(backend.play()).rejects.toEqual({
      status: 500,
      message: "provider rejected command",
    })
    await expect(backend.seek?.(50_000)).rejects.toEqual({
      status: 500,
      message: "provider rejected command",
    })
    const unchanged = syncFromSample({
      key: trackKey("Song", "Artist", "provider-id"),
      reported_ms: 0,
      reported: false,
      duration_ms: 180_000,
      playing: null,
      rate: Number.NaN,
      now: Date.now(),
    })

    expect(unchanged.is_playing).toBe(false)
    expect(unchanged.progress_ms).toBe(10_000)
  })
})

describe("startLineStream", () => {
  test("forwards complete lines across split and multi-line chunks", () => {
    const child = new FakeLineStreamProcess()
    const lines: string[] = []
    startLineStream(
      ["media-control", "stream"],
      { onLine: (line) => lines.push(line), onTerminal: () => {} },
      () => child,
    )

    child.stdout.emit("data", "first\nsec")
    child.stdout.emit("data", "ond\n\nthird\n")

    expect(lines).toEqual(["first", "second", "third"])
  })

  test("disposal removes listeners, discards partial output, and kills the child", () => {
    const child = new FakeLineStreamProcess()
    const lines: string[] = []
    const dispose = startLineStream(
      ["media-control", "stream"],
      { onLine: (line) => lines.push(line), onTerminal: () => {} },
      () => child,
    )

    child.stdout.emit("data", "partial")
    dispose()
    child.stdout.emit("data", " line\n")

    expect(child.stdout.listenerCount("data")).toBe(0)
    expect(child.listenerCount("error")).toBe(0)
    expect(child.listenerCount("exit")).toBe(0)
    expect(child.listenerCount("close")).toBe(0)
    expect(child.killCalls).toBe(1)
    expect(lines).toEqual([])
  })

  test("stops remaining lines when a line callback disposes the stream", () => {
    const child = new FakeLineStreamProcess()
    const lines: string[] = []
    let dispose = () => {}
    dispose = startLineStream(
      ["media-control", "stream"],
      {
        onLine: (line) => {
          lines.push(line)
          dispose()
        },
        onTerminal: () => {},
      },
      () => child,
    )

    child.stdout.emit("data", "first\nsecond\n")

    expect(lines).toEqual(["first"])
  })

  test("notifies once when error, exit, and close arrive together", () => {
    const child = new FakeLineStreamProcess()
    let terminals = 0
    startLineStream(
      ["media-control", "stream"],
      { onLine: () => {}, onTerminal: () => terminals++ },
      () => child,
    )

    child.emit("error", new Error("stream failed"))
    child.emit("exit", 1)
    child.emit("close", 1)

    expect(terminals).toBe(1)
  })
})

describe("media-control stream subscription", () => {
  test("keeps stream hooks optional for existing dependency objects", () => {
    const dependencies = {
      run: async () => ({ ok: true, out: "", err: "" }),
      detectBackend: () => null,
      hasNowPlayingCli: () => false,
    } satisfies SystemMediaDependencies

    expect(createSystemMedia(dependencies).subscribe).toBeUndefined()
  })

  // Every provider change is only an invalidation; player() remains the state boundary.
  test("notifies for full and empty data envelopes", () => {
    const fake = createStreamFakes()
    const changes: string[] = []
    fake.backend.subscribe?.(() => changes.push("changed"))

    const source = fake.sources[0]!
    source.callbacks.onLine(
      '{"type":"data","diff":false,"payload":{"title":"Song","playing":true}}',
    )
    source.callbacks.onLine(
      '{"type":"data","diff":false,"payload":{"playing":false}}',
    )
    source.callbacks.onLine(
      '{"type":"data","diff":false,"payload":{"elapsedTime":10,"timestamp":"now"}}',
    )
    source.callbacks.onLine('{"type":"data","diff":false,"payload":{}}')

    expect(changes).toEqual(["changed", "changed", "changed", "changed"])
  })

  // Bad stream output must not wedge the next valid provider event.
  test("ignores malformed and invalid envelopes", () => {
    const fake = createStreamFakes()
    let changes = 0
    fake.backend.subscribe?.(() => changes++)

    const source = fake.sources[0]!
    source.callbacks.onLine("not json")
    source.callbacks.onLine('{"type":"data","payload":null}')
    source.callbacks.onLine('{"type":"data","payload":[]}')
    source.callbacks.onLine('{"type":"status","payload":{}}')
    source.callbacks.onLine('{"type":"data","payload":{}}')

    expect(changes).toBe(1)
  })

  test("restarts once after terminal error or exit", () => {
    const fake = createStreamFakes()
    fake.backend.subscribe?.(() => {})

    fake.sources[0]!.callbacks.onTerminal()
    expect(fake.timers.map((entry) => entry.delayMs)).toEqual([1_000])
    fake.runNextTimer()
    expect(fake.sources).toHaveLength(2)

    fake.sources[1]!.callbacks.onTerminal()
    expect(fake.timers.map((entry) => entry.delayMs)).toEqual([1_000, 2_000])
  })

  test("deduplicates error and close from one stream generation", () => {
    const fake = createStreamFakes()
    fake.backend.subscribe?.(() => {})

    fake.sources[0]!.callbacks.onTerminal()
    fake.sources[0]!.callbacks.onTerminal()
    expect(fake.timers.filter((entry) => entry.active)).toHaveLength(1)
    fake.runNextTimer()
    expect(fake.sources).toHaveLength(2)
  })

  test("resets retry backoff after a valid event", () => {
    const fake = createStreamFakes()
    fake.backend.subscribe?.(() => {})
    fake.sources[0]!.callbacks.onTerminal()
    fake.runNextTimer()
    fake.sources[1]!.callbacks.onLine('{"type":"data","payload":{}}')
    fake.sources[1]!.callbacks.onTerminal()

    expect(fake.timers.map((entry) => entry.delayMs)).toEqual([1_000, 1_000])
  })

  test("nowplaying-cli remains polling-only", async () => {
    const backend = createSystemMedia({
      detectBackend: () => "nowplaying-cli",
      hasNowPlayingCli: () => true,
      run: async () => ({ ok: true, out: "{}" }),
      startLineStream: () => () => {},
      setRetryTimer: setTimeout,
      clearRetryTimer: clearTimeout,
    })

    expect(backend.subscribe).toBeUndefined()
    expect((await backend.player())?.track).toBeNull()
  })

  test("disposal cancels retries, stops the source, and ignores late callbacks", () => {
    const fake = createStreamFakes()
    let changes = 0
    const dispose = fake.backend.subscribe!(() => changes++)
    const source = fake.sources[0]!

    source.callbacks.onTerminal()
    dispose()
    dispose()
    source.callbacks.onLine('{"data":{}}')
    source.callbacks.onTerminal()

    expect(source.disposed).toBe(1)
    expect(fake.timers[0]!.active).toBeFalse()
    expect(changes).toBe(0)
    expect(fake.sources).toHaveLength(1)
  })
})
