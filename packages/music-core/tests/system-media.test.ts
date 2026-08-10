import { beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { trackKey } from "../clock.ts"
import { mergePlayer } from "../reconcile.ts"
import { run, startLineStream } from "../run.ts"
import {
  bundleLabel,
  createSystemMedia,
  effectiveBundle,
  resetMediaBackend,
  type SystemMediaDependencies,
} from "../system-media.ts"
import type { MusicChangeEvent } from "../types.ts"
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

function createStreamFakes(options?: { now?: () => number }) {
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
  const getCalls: string[][] = []
  const backend = createSystemMedia({
    detectBackend: () => "media-control",
    hasNowPlayingCli: () => false,
    run: async (cmd) => {
      getCalls.push(cmd)
      return { ok: true, out: "" }
    },
    startLineStream: (_cmd, callbacks) => {
      const source = { callbacks, disposed: 0 }
      sources.push(source)
      return () => {
        source.disposed++
      }
    },
    setRetryTimer: timer,
    clearRetryTimer: clearTimer,
    ...(options?.now ? { now: options.now } : {}),
  })
  return {
    backend,
    sources,
    timers,
    getCalls,
    runNextTimer() {
      const next = timers.find((entry) => entry.active)
      if (!next) throw new Error("no active retry timer")
      next.active = false
      next.callback()
    },
  }
}

const completePausedPayload = {
  contentItemIdentifier: "provider-id",
  title: "Song",
  artist: "Artist",
  album: "Album",
  duration: 180,
  elapsedTimeNow: 12.5,
  playing: false,
  bundleIdentifier: "com.Spotify.client",
}

function dataEnvelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: "data", diff: false, payload })
}

beforeEach(() => {
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
    const unchanged = await backend.player()

    expect(unchanged?.is_playing).toBe(false)
    expect(unchanged?.progress_ms).toBe(10_000)
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

  // App-originated pause must land immediately from the stream without polling.
  test("emits an authoritative paused snapshot without calling player()", () => {
    const arrival = 1_700_000_000_000
    const fake = createStreamFakes({ now: () => arrival })
    const events: MusicChangeEvent[] = []
    fake.backend.subscribe?.((event) => {
      if (event) events.push(event)
    })

    fake.sources[0]!.callbacks.onLine(dataEnvelope(completePausedPayload))

    expect(fake.getCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: "snapshot",
      state: {
        is_playing: false,
        progress_ms: 12_500,
        shuffle: false,
        repeat: "off",
        device: {
          id: "system",
          name: "Spotify",
          type: "Computer",
          is_active: true,
          volume_percent: null,
          supports_volume: false,
        },
        track: {
          id: "provider-id",
          uri: "system:now:Song",
          name: "Song",
          artists: "Artist",
          album: "Album",
          duration_ms: 180_000,
        },
        fetched_at: arrival,
      },
    })
  })

  // Polled get and stream payloads must share one decoder and arrival clock.
  test("player() and stream snapshots share normalization and arrival timestamps", async () => {
    const arrival = 1_700_000_000_500
    const payload = {
      ...completePausedPayload,
      elapsedTimeNow: 20,
      playing: true,
    }
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      now: () => arrival,
      run: async () => ({ ok: true, out: JSON.stringify(payload) }),
      startLineStream: (_cmd, callbacks) => {
        queueMicrotask(() => callbacks.onLine(dataEnvelope(payload)))
        return () => {}
      },
      setRetryTimer: setTimeout,
      clearRetryTimer: clearTimeout,
    })

    const polled = await backend.player()
    let streamed: MusicChangeEvent | undefined
    backend.subscribe?.((event) => {
      streamed = event
    })
    await Promise.resolve()

    expect(streamed?.type).toBe("snapshot")
    if (streamed?.type !== "snapshot") throw new Error("expected snapshot")
    expect(polled).not.toBeNull()
    expect(streamed.state).toEqual(polled!)
    expect(polled!.fetched_at).toBe(arrival)
    expect(polled!.is_playing).toBe(true)
    expect(polled!.progress_ms).toBe(20_000)
  })

  // Bad stream output must not wedge the next valid provider event.
  test("ignores malformed, non-data, and incomplete envelopes then accepts a valid one", () => {
    const fake = createStreamFakes({ now: () => 42 })
    const events: MusicChangeEvent[] = []
    fake.backend.subscribe?.((event) => {
      if (event) events.push(event)
    })

    const source = fake.sources[0]!
    source.callbacks.onLine("not json")
    source.callbacks.onLine('{"type":"data","payload":null}')
    source.callbacks.onLine('{"type":"data","payload":[]}')
    source.callbacks.onLine('{"type":"status","payload":{}}')
    source.callbacks.onLine('{"type":"data","payload":{}}')
    source.callbacks.onLine(dataEnvelope({ elapsedTime: 10, timestamp: "now" }))
    // Boolean-only and identity-only payloads are partial — do not invent defaults.
    source.callbacks.onLine(dataEnvelope({ playing: false }))
    source.callbacks.onLine(dataEnvelope({ title: "Song" }))
    source.callbacks.onLine(
      dataEnvelope({
        title: "Song",
        artist: "Artist",
        album: "Album",
        playing: false,
      }),
    )
    source.callbacks.onLine(dataEnvelope(completePausedPayload))

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("snapshot")
    if (events[0]?.type !== "snapshot") throw new Error("expected snapshot")
    expect(events[0].state.is_playing).toBe(false)
    expect(events[0].state.track?.name).toBe("Song")
    expect(events[0].state.progress_ms).toBe(12_500)
  })

  // Complete idle still emits; empty/null values are valid when the shape is full.
  test("emits idle from a complete payload with empty identity values", () => {
    const arrival = 99
    const fake = createStreamFakes({ now: () => arrival })
    const events: MusicChangeEvent[] = []
    fake.backend.subscribe?.((event) => {
      if (event) events.push(event)
    })

    fake.sources[0]!.callbacks.onLine(
      dataEnvelope({
        contentItemIdentifier: null,
        title: "",
        artist: "",
        album: "",
        duration: 0,
        elapsedTime: 0,
        playing: false,
        bundleIdentifier: null,
      }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: "snapshot",
      state: {
        is_playing: false,
        progress_ms: 0,
        shuffle: false,
        repeat: "off",
        device: {
          id: "system",
          name: "Nothing playing",
          type: "Computer",
          is_active: false,
          volume_percent: null,
          supports_volume: false,
        },
        track: null,
        fetched_at: arrival,
      },
    })
  })

  // Existing no-arg listeners must keep compiling and receiving calls.
  test("supports listeners that ignore the event argument", () => {
    const fake = createStreamFakes()
    let changes = 0
    fake.backend.subscribe?.(() => {
      changes++
    })

    fake.sources[0]!.callbacks.onLine(dataEnvelope(completePausedPayload))
    expect(changes).toBe(1)
  })

  test("terminal error/exit/close emit one immediate invalidation and one restart", () => {
    const fake = createStreamFakes()
    const events: MusicChangeEvent[] = []
    fake.backend.subscribe?.((event) => {
      if (event) events.push(event)
    })

    fake.sources[0]!.callbacks.onTerminal()
    fake.sources[0]!.callbacks.onTerminal()
    fake.sources[0]!.callbacks.onTerminal()

    expect(events).toEqual([
      { type: "invalidation", reason: "stream-terminated" },
    ])
    expect(fake.timers.filter((entry) => entry.active)).toHaveLength(1)
    expect(fake.timers.map((entry) => entry.delayMs)).toEqual([1_000])
    fake.runNextTimer()
    expect(fake.sources).toHaveLength(2)
  })

  test("disposal from an invalidation listener does not leave a retry timer", () => {
    const fake = createStreamFakes()
    let dispose: (() => void) | undefined
    dispose = fake.backend.subscribe!((event) => {
      if (event?.type === "invalidation") dispose?.()
    })

    fake.sources[0]!.callbacks.onTerminal()

    expect(fake.timers.filter((entry) => entry.active)).toHaveLength(0)
    expect(fake.sources[0]!.disposed).toBe(1)
  })

  test("retry delays cap at 1/2/4/8 seconds and reset after a valid snapshot", () => {
    const fake = createStreamFakes()
    fake.backend.subscribe?.(() => {})

    fake.sources[0]!.callbacks.onTerminal()
    fake.runNextTimer()
    fake.sources[1]!.callbacks.onTerminal()
    fake.runNextTimer()
    fake.sources[2]!.callbacks.onTerminal()
    fake.runNextTimer()
    fake.sources[3]!.callbacks.onTerminal()
    fake.runNextTimer()
    fake.sources[4]!.callbacks.onTerminal()

    expect(fake.timers.map((entry) => entry.delayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000,
    ])

    fake.runNextTimer()
    fake.sources[5]!.callbacks.onLine(dataEnvelope(completePausedPayload))
    fake.sources[5]!.callbacks.onTerminal()

    expect(fake.timers.map((entry) => entry.delayMs).at(-1)).toBe(1_000)
  })

  test("nowplaying-cli remains polling-only and returns normalized state", async () => {
    const backend = createSystemMedia({
      detectBackend: () => "nowplaying-cli",
      hasNowPlayingCli: () => true,
      run: async () => ({
        ok: true,
        out: JSON.stringify({
          title: "Cli Song",
          artist: "Cli Artist",
          album: "Cli Album",
          duration: 90,
          elapsedTime: 15,
          playbackRate: 1,
          isPlaying: true,
        }),
      }),
      startLineStream: () => () => {},
      setRetryTimer: setTimeout,
      clearRetryTimer: clearTimeout,
    })

    expect(backend.subscribe).toBeUndefined()
    const state = await backend.player()
    expect(state?.track?.name).toBe("Cli Song")
    expect(state?.track?.artists).toBe("Cli Artist")
    expect(state?.progress_ms).toBe(15_000)
    expect(state?.is_playing).toBe(true)
  })

  test("two backends keep independent sampled and transport-mutated clocks", async () => {
    const leftSample = {
      contentItemIdentifier: "left-id",
      title: "Left Song",
      artist: "Left Artist",
      duration: 180,
      elapsedTimeNow: 10,
      playing: true,
    }
    const rightSample = {
      contentItemIdentifier: "right-id",
      title: "Right Song",
      artist: "Right Artist",
      duration: 240,
      elapsedTimeNow: 40,
      playing: false,
    }
    const left = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) =>
        command[1] === "get"
          ? { ok: true, out: JSON.stringify(leftSample) }
          : { ok: true, out: "" },
    })
    const right = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) =>
        command[1] === "get"
          ? { ok: true, out: JSON.stringify(rightSample) }
          : { ok: true, out: "" },
    })

    expect((await left.player())?.track?.name).toBe("Left Song")
    expect((await right.player())?.track?.name).toBe("Right Song")

    await left.pause?.()
    await right.play()
    await left.seek?.(2_000)
    await right.seek?.(55_000)

    leftSample.elapsedTimeNow = 10
    leftSample.playing = true
    rightSample.elapsedTimeNow = 40
    rightSample.playing = false

    // Sticky transport mutations survive a later sample that omits playing/progress.
    const leftSticky = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) =>
        command[1] === "get"
          ? {
              ok: true,
              out: JSON.stringify({
                contentItemIdentifier: "left-id",
                title: "Left Song",
                artist: "Left Artist",
                duration: 180,
                playing: false,
              }),
            }
          : { ok: true, out: "" },
    })
    const rightSticky = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) =>
        command[1] === "get"
          ? {
              ok: true,
              out: JSON.stringify({
                contentItemIdentifier: "right-id",
                title: "Right Song",
                artist: "Right Artist",
                duration: 240,
                playing: true,
              }),
            }
          : { ok: true, out: "" },
    })

    await leftSticky.player()
    await rightSticky.player()
    await leftSticky.pause?.()
    await rightSticky.play()
    await leftSticky.seek?.(3_000)
    await rightSticky.seek?.(70_000)
    await leftSticky.next?.()
    await rightSticky.previous?.()

    const leftAfterSkip = await leftSticky.player()
    const rightAfterSkip = await rightSticky.player()

    // next/previous reset only the owning backend clock before the next sample.
    expect(leftAfterSkip?.progress_ms).toBe(0)
    expect(rightAfterSkip?.progress_ms).toBe(0)
    expect(leftAfterSkip?.track?.name).toBe("Left Song")
    expect(rightAfterSkip?.track?.name).toBe("Right Song")
  })

  test("two live backends do not cross-contaminate pause and seek state", async () => {
    const leftPayload = {
      contentItemIdentifier: "left-id",
      title: "Left Song",
      artist: "Left Artist",
      duration: 180,
      elapsedTimeNow: 10,
      playing: true,
    }
    const rightPayload = {
      contentItemIdentifier: "right-id",
      title: "Right Song",
      artist: "Right Artist",
      duration: 240,
      elapsedTimeNow: 40,
      playing: false,
    }
    const left = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) =>
        command[1] === "get"
          ? { ok: true, out: JSON.stringify(leftPayload) }
          : { ok: true, out: "" },
    })
    const right = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) =>
        command[1] === "get"
          ? { ok: true, out: JSON.stringify(rightPayload) }
          : { ok: true, out: "" },
    })

    await left.player()
    await right.player()
    await left.pause?.()
    await right.play()
    await left.seek?.(2_500)
    await right.seek?.(51_000)

    // Drop reported progress so sticky clock state is observable.
    delete (leftPayload as { elapsedTimeNow?: number }).elapsedTimeNow
    delete (rightPayload as { elapsedTimeNow?: number }).elapsedTimeNow
    leftPayload.playing = true
    rightPayload.playing = false

    const leftState = await left.player()
    const rightState = await right.player()

    expect(leftState?.is_playing).toBe(true)
    expect(rightState?.is_playing).toBe(false)
    expect(leftState?.progress_ms).toBe(2_500)
    expect(rightState?.progress_ms).toBe(51_000)
    expect(leftState?.track?.name).toBe("Left Song")
    expect(rightState?.track?.name).toBe("Right Song")
  })

  test("disposal cancels retries, stops the source once, and suppresses late events", () => {
    const fake = createStreamFakes()
    const events: MusicChangeEvent[] = []
    const dispose = fake.backend.subscribe!((event) => {
      if (event) events.push(event)
    })
    const source = fake.sources[0]!

    source.callbacks.onTerminal()
    expect(events).toEqual([
      { type: "invalidation", reason: "stream-terminated" },
    ])
    dispose()
    dispose()
    source.callbacks.onLine(dataEnvelope(completePausedPayload))
    source.callbacks.onTerminal()
    fake.timers[0]!.callback()

    expect(source.disposed).toBe(1)
    expect(fake.timers[0]!.active).toBeFalse()
    expect(events).toHaveLength(1)
    expect(fake.sources).toHaveLength(1)
  })
})
