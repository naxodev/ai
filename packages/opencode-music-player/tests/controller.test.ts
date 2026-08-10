import { describe, expect, test } from "bun:test"
import type {
  ArtworkCompletionEvent,
  MusicBackend,
  PlayerState,
} from "../types.ts"
import { createSystemMedia } from "../system-media.ts"
import {
  createController,
  optimisticPlayerState,
  optimisticSeekPlayerState,
} from "../index.tsx"

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function player(isPlaying = true, track = true): PlayerState {
  return {
    is_playing: isPlaying,
    progress_ms: 0,
    shuffle: false,
    repeat: "off",
    device: null,
    track: track
      ? {
          id: "song",
          uri: "system:song",
          name: "Song",
          artists: "Artist",
          album: "Album",
          duration_ms: 180_000,
          artwork: null,
        }
      : null,
    fetched_at: Date.now(),
  }
}

function flush() {
  return Promise.resolve().then(() => Promise.resolve())
}

function createHarness(
  options: {
    subscribe?: boolean
    samples?: PlayerState[]
    play?: () => Promise<void>
    seek?: (positionMs: number) => Promise<void>
    includeSeek?: boolean
    delay?: (ms: number) => Promise<void>
    backend?: MusicBackend
  } = {},
) {
  const timers: Array<{
    callback: () => void
    delay: number
    active: boolean
  }> = []
  const samples = options.samples ?? [player()]
  const requests: Array<Deferred<PlayerState | null>> = []
  let listener: (() => void) | null = null
  let presentationListener: ((event: ArtworkCompletionEvent) => void) | null =
    null
  let subscriptions = 0
  let subscriptionDisposals = 0
  let presentationDisposals = 0
  const backend =
    options.backend ??
    (() => {
      const fake: MusicBackend = {
        id: "fake",
        label: "Fake",
        remoteControl: true,
        authenticated: () => true,
        player: () => {
          const next = samples.shift()
          if (next) return Promise.resolve(next)
          const request = deferred<PlayerState | null>()
          requests.push(request)
          return request.promise
        },
        searchTracks: async () => [],
        play: options.play ?? (async () => {}),
      }
      if (options.includeSeek !== false)
        fake.seek = options.seek ?? (async () => {})
      if (options.subscribe !== false) {
        fake.subscribe = (nextListener) => {
          subscriptions++
          listener = nextListener
          return () => {
            subscriptionDisposals++
          }
        }
      }
      fake.subscribePresentation = (nextListener) => {
        presentationListener = nextListener
        return () => {
          presentationDisposals++
          presentationListener = null
        }
      }
      return fake
    })()
  const mutations: Array<{
    loading: boolean
    error: string | null
    player: PlayerState | null
  }> = []
  const state = {
    loading: false,
    error: null as string | null,
    player: null as PlayerState | null,
  }
  const toasts: unknown[] = []
  const context = {
    storage: {
      memory: () => [
        state,
        (mutate: (draft: typeof state) => void) => {
          mutate(state)
          mutations.push({ ...state })
        },
      ],
    },
    ui: { toast: { show: (toast: unknown) => toasts.push(toast) } },
  }
  const controller = createController(context as never, {
    createBackend: () => backend,
    scheduleTimeout: ((callback: () => void, delay: number) => {
      const timer = { callback, delay, active: true }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    }) as any,
    clearScheduledTimeout: ((timer: ReturnType<typeof setTimeout>) => {
      ;(timer as unknown as { active: boolean }).active = false
    }) as any,
    delay: options.delay ?? (async () => {}),
  })
  return {
    controller,
    emit: () => listener?.(),
    emitPresentation: (event: ArtworkCompletionEvent) =>
      presentationListener?.(event),
    mutations,
    requests,
    subscriptions: () => subscriptions,
    subscriptionDisposals: () => subscriptionDisposals,
    presentationDisposals: () => presentationDisposals,
    timers,
    activeTimers: () => timers.filter((timer) => timer.active),
    fire(timer: (typeof timers)[number]) {
      timer.active = false
      timer.callback()
    },
    toasts,
  }
}

describe("OpenCode music controller", () => {
  test("subscribes, samples initially, and schedules from the sampled state", async () => {
    const harness = createHarness()
    await flush()

    expect(harness.subscriptions()).toBe(1)
    expect(harness.activeTimers()).toHaveLength(1)
    expect(harness.activeTimers()[0]?.delay).toBe(3000)
  })

  test("refreshes for a standalone event before the poll deadline", async () => {
    const harness = createHarness({ samples: [player()] })
    await flush()

    harness.emit()
    expect(harness.requests).toHaveLength(1)
    expect(harness.activeTimers()).toHaveLength(0)

    harness.requests[0]!.resolve(player())
    await flush()
    expect(harness.activeTimers()[0]?.delay).toBe(3000)
  })

  test("applies facade snapshots and artwork completions without resampling", async () => {
    const artwork = deferred<{
      artwork: { id: string; png_base64: string; accent: string; cells: [] }
      duration_ms: number
    }>()
    const playback = deferred<{ ok: true; out: string }>()
    const stream = {
      listener: null as ((line: string) => void) | null,
      disposals: 0,
    }
    let playbackSamples = 0
    const basePayload = {
      contentItemIdentifier: "controller-artwork-lane",
      title: "Controller Artwork Lane",
      artist: "Artist",
      album: "Album",
      duration: 180,
      elapsedTimeNow: 12,
      bundleIdentifier: "com.Spotify.client",
    }
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) => {
        if (command.includes("--no-artwork")) {
          playbackSamples++
          return playback.promise
        }
        return {
          ok: true,
          out: JSON.stringify({
            ...basePayload,
            playing: true,
            artworkData: command.includes("--no-artwork") ? undefined : "cover",
          }),
        }
      },
      resolveArtworkDetails: () => artwork.promise,
      startLineStream: (_command, callbacks) => {
        stream.listener = callbacks.onLine
        return () => stream.disposals++
      },
      setRetryTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearRetryTimer: () => {},
    })
    const harness = createHarness({ backend })
    await flush()

    expect(harness.controller.session.player).toBeNull()
    expect(playbackSamples).toBe(1)

    stream.listener?.(
      JSON.stringify({
        type: "data",
        payload: { ...basePayload, elapsedTimeNow: 0, playing: true },
      }),
    )
    expect(harness.controller.session.player).toMatchObject({
      is_playing: true,
      progress_ms: 0,
      track: { artwork: null, artwork_loading: true },
    })
    expect(playbackSamples).toBe(1)

    artwork.resolve({
      artwork: { id: "cover", png_base64: "png", accent: "blue", cells: [] },
      duration_ms: 180_000,
    })
    await flush()
    await flush()

    expect(harness.controller.session.player).toMatchObject({
      is_playing: true,
      track: { artwork_loading: false, artwork: { id: "cover" } },
    })
    expect(playbackSamples).toBe(1)

    const mutations = harness.mutations.length
    harness.controller.dispose()
    playback.resolve({
      ok: true,
      out: JSON.stringify({ ...basePayload, playing: false }),
    })
    await flush()

    expect(stream.disposals).toBe(1)
    expect(harness.mutations).toHaveLength(mutations)
    expect(playbackSamples).toBe(1)
    expect(harness.toasts).toHaveLength(0)
  })

  test("merges artwork completion without sampling or changing playback", async () => {
    const initial = player(false)
    initial.track!.artwork_loading = true
    const harness = createHarness({ samples: [initial] })
    await flush()

    harness.emitPresentation({
      type: "artwork-completion",
      identity: {
        uid: "previous-provider-id",
        title: "Song",
        artist: "Artist",
        album: "Album",
        duration_ms: 180_000,
      },
      artwork: { id: "cover", png_base64: "png", accent: "blue", cells: [] },
      duration_ms: 180_000,
    })

    expect(harness.requests).toHaveLength(0)
    expect(harness.controller.session.player).toMatchObject({
      is_playing: false,
      track: { artwork_loading: false, artwork: { id: "cover" } },
    })
  })

  test("rejects replaced artwork and drops it after controller disposal", async () => {
    const trackA = player(false)
    trackA.track!.artwork_loading = true
    const trackB = player(true)
    trackB.track = { ...trackB.track!, id: "b", name: "Replacement" }
    const harness = createHarness({ samples: [trackA, trackB] })
    await flush()
    await harness.controller.refreshAll()

    const event: ArtworkCompletionEvent = {
      type: "artwork-completion",
      identity: {
        uid: "a",
        title: "Song",
        artist: "Artist",
        album: "Album",
        duration_ms: 180_000,
      },
      artwork: { id: "cover", png_base64: "png", accent: "blue", cells: [] },
      duration_ms: 180_000,
    }
    harness.emitPresentation(event)
    expect(harness.controller.session.player?.track).toMatchObject({
      name: "Replacement",
      artwork: null,
    })

    const mutations = harness.mutations.length
    harness.controller.dispose()
    harness.controller.dispose()
    harness.emitPresentation(event)
    expect(harness.mutations).toHaveLength(mutations)
    expect(harness.presentationDisposals()).toBe(1)
    expect(harness.toasts).toHaveLength(0)
  })

  test("serializes event refreshes into one catch-up sample", async () => {
    const harness = createHarness({ samples: [] })
    const first = harness.requests[0]!

    harness.emit()
    harness.emit()
    expect(harness.requests).toHaveLength(1)
    first.resolve(player())
    await flush()
    expect(harness.requests).toHaveLength(2)
    const second = harness.requests[1]!
    second.resolve(player(false))
    await flush()

    expect(harness.activeTimers()).toHaveLength(1)
    expect(harness.activeTimers()[0]?.delay).toBe(5000)
  })

  test("keeps bounded polling for subscribed backends", async () => {
    const subscribed = createHarness({
      samples: [player(), player(false), player(false, false)],
    })
    await flush()
    subscribed.fire(subscribed.activeTimers()[0]!)
    await flush()
    expect(subscribed.activeTimers()[0]?.delay).toBe(5000)
    subscribed.fire(subscribed.activeTimers()[0]!)
    await flush()
    expect(subscribed.activeTimers()[0]?.delay).toBe(8000)
  })

  test("uses 3/5/8-second poll bounds without a subscription", async () => {
    const harness = createHarness({
      subscribe: false,
      samples: [player(), player(false), player(false, false)],
    })
    await flush()

    expect(harness.subscriptions()).toBe(0)
    expect(harness.activeTimers()[0]?.delay).toBe(3000)
    harness.fire(harness.activeTimers()[0]!)
    await flush()
    expect(harness.activeTimers()[0]?.delay).toBe(5000)
    harness.fire(harness.activeTimers()[0]!)
    await flush()
    expect(harness.activeTimers()[0]?.delay).toBe(8000)
  })

  test("replaces the poll deadline after event-driven state changes", async () => {
    const harness = createHarness({
      samples: [player(), player(false), player(false, false)],
    })
    await flush()
    const playingPoll = harness.activeTimers()[0]!

    harness.emit()
    await flush()
    expect(playingPoll.active).toBe(false)
    expect(harness.activeTimers()).toHaveLength(1)
    expect(harness.activeTimers()[0]?.delay).toBe(5000)

    const pausedPoll = harness.activeTimers()[0]!
    harness.emit()
    await flush()
    expect(pausedPoll.active).toBe(false)
    expect(harness.activeTimers()).toHaveLength(1)
    expect(harness.activeTimers()[0]?.delay).toBe(8000)
  })

  test("does not let a pre-transport sample undo optimistic playback", async () => {
    const transport = deferred<void>()
    const harness = createHarness({
      samples: [player(false)],
      play: () => transport.promise,
    })
    await flush()

    harness.emit()
    const stale = harness.requests[0]!
    const command = harness.controller.playPause()
    transport.resolve()
    await flush()
    expect(harness.mutations.at(-1)?.player?.is_playing).toBe(true)

    stale.resolve(player(false))
    await flush()
    expect(harness.mutations.at(-1)?.player?.is_playing).toBe(true)

    harness.requests[1]!.resolve(player(true))
    await command
    expect(harness.mutations.at(-1)?.player?.is_playing).toBe(true)
  })

  test("seeks optimistically and reconciles with the provider", async () => {
    const command = deferred<void>()
    const calls: number[] = []
    const initial = { ...player(false), progress_ms: 30_000, fetched_at: 1_000 }
    const confirmed = {
      ...player(false),
      progress_ms: 89_750,
      fetched_at: 2_000,
    }
    const harness = createHarness({
      samples: [initial],
      seek: (positionMs) => {
        calls.push(positionMs)
        return command.promise
      },
    })
    await flush()

    const seeking = harness.controller.seek(90_000)
    await flush()
    expect(calls).toEqual([90_000])
    expect(harness.controller.session.player).toMatchObject({
      progress_ms: 90_000,
      is_playing: false,
    })

    command.resolve()
    await flush()
    harness.requests[0]!.resolve(confirmed)
    await seeking
    expect(harness.controller.session.player).toMatchObject({
      progress_ms: 89_750,
      fetched_at: 2_000,
    })
  })

  test("restores progress and reports a provider seek failure", async () => {
    const command = deferred<void>()
    const initial = { ...player(false), progress_ms: 30_000, fetched_at: 1_000 }
    const harness = createHarness({
      samples: [initial],
      seek: () => command.promise,
    })
    await flush()

    const seeking = harness.controller.seek(90_000)
    await flush()
    expect(harness.controller.session.player?.progress_ms).toBe(90_000)
    command.reject(new Error("seek failed"))
    await flush()
    expect(harness.controller.session.player).toMatchObject({
      progress_ms: 30_000,
      fetched_at: 1_000,
    })
    harness.requests[0]!.resolve(initial)
    await seeking

    expect(harness.controller.session.player).toMatchObject({
      progress_ms: 30_000,
      fetched_at: 1_000,
    })
    expect(harness.controller.session.error).toBe("seek failed")
    expect(harness.toasts).toHaveLength(1)
    expect(harness.requests).toHaveLength(1)
  })

  test("ignores seeks without a track, duration, or backend support", async () => {
    const noTrack = createHarness({ samples: [player(false, false)] })
    await flush()
    await noTrack.controller.seek(10_000)
    expect(noTrack.mutations.at(-1)?.loading).toBe(false)

    const noDuration = player(false)
    noDuration.track!.duration_ms = 0
    const invalidDuration = createHarness({ samples: [noDuration] })
    await flush()
    await invalidDuration.controller.seek(10_000)
    expect(invalidDuration.mutations.at(-1)?.loading).toBe(false)

    const unsupported = createHarness({
      samples: [player(false)],
      includeSeek: false,
    })
    await flush()
    await unsupported.controller.seek(10_000)
    expect(unsupported.mutations.at(-1)?.loading).toBe(false)
    expect(unsupported.toasts).toHaveLength(0)

    const invalidPositionCalls: number[] = []
    const invalidPosition = createHarness({
      samples: [player(false)],
      seek: async (position) => {
        invalidPositionCalls.push(position)
      },
    })
    await flush()
    await invalidPosition.controller.seek(Number.NaN)
    expect(invalidPositionCalls).toHaveLength(0)
  })

  test("does not let an overlapping sample undo an optimistic seek", async () => {
    const transport = deferred<void>()
    const harness = createHarness({
      samples: [player(false)],
      seek: () => transport.promise,
    })
    await flush()

    harness.emit()
    const stale = harness.requests[0]!
    const seeking = harness.controller.seek(90_000)
    await flush()
    stale.resolve({ ...player(false), progress_ms: 5_000 })
    await flush()
    expect(harness.controller.session.player?.progress_ms).toBe(90_000)

    transport.resolve()
    await flush()
    harness.requests[1]!.resolve({ ...player(false), progress_ms: 89_500 })
    await seeking
    expect(harness.controller.session.player?.progress_ms).toBe(89_500)
  })

  test("blocks stale samples through settling without blocking transport", async () => {
    const settling = deferred<void>()
    let plays = 0
    let delays = 0
    const harness = createHarness({
      samples: [player(false)],
      play: async () => {
        plays++
      },
      seek: async () => {},
      delay: () => (++delays === 1 ? settling.promise : Promise.resolve()),
    })
    await flush()

    const seeking = harness.controller.seek(90_000)
    await flush()
    harness.emit()
    harness.requests[0]!.resolve({ ...player(false), progress_ms: 5_000 })
    await flush()
    expect(harness.controller.session.player?.progress_ms).toBe(90_000)

    const playing = harness.controller.playPause()
    await flush()
    expect(plays).toBe(1)
    expect(harness.controller.session.player?.is_playing).toBe(true)
    harness.requests[1]!.resolve({
      ...player(true),
      progress_ms: 5_000,
    })
    await playing
    expect(harness.controller.session.player?.progress_ms).toBe(90_000)

    settling.resolve()
    await flush()
    harness.requests[2]!.resolve({
      ...player(true),
      progress_ms: 90_000,
    })
    await seeking
    expect(harness.controller.session.player).toMatchObject({
      is_playing: true,
      progress_ms: 90_000,
    })
  })

  test("retries failures and suppresses late completions after disposal", async () => {
    const harness = createHarness({ samples: [] })
    const pending = harness.requests[0]!
    harness.controller.dispose()
    harness.controller.dispose()
    pending.reject(new Error("late failure"))
    await flush()

    expect(harness.subscriptionDisposals()).toBe(1)
    expect(harness.activeTimers()).toHaveLength(0)
    expect(harness.mutations).toHaveLength(1)
    expect(harness.toasts).toHaveLength(0)
  })

  test("schedules a retry after an active sample failure", async () => {
    const harness = createHarness({ samples: [] })
    const failure = harness.requests[0]!
    failure.reject(new Error("temporary failure"))
    await flush()

    expect(harness.activeTimers()[0]?.delay).toBe(8000)
    expect(harness.mutations.at(-1)?.error).toBe("temporary failure")
  })

  test("clears a sampling error after a successful retry", async () => {
    const harness = createHarness({ samples: [] })
    harness.requests[0]!.reject(new Error("temporary failure"))
    await flush()

    harness.fire(harness.activeTimers()[0]!)
    expect(harness.requests).toHaveLength(2)
    harness.requests[1]!.resolve(player())
    await flush()

    expect(harness.mutations.at(-1)?.error).toBeNull()
    expect(harness.mutations.at(-1)?.player?.track?.id).toBe("song")
  })

  test("serializes a manual refresh that overlaps an event", async () => {
    const harness = createHarness({ samples: [player()] })
    await flush()

    const manualRefresh = harness.controller.refreshAll()
    expect(harness.requests).toHaveLength(1)
    harness.emit()
    expect(harness.requests).toHaveLength(1)

    harness.requests[0]!.resolve(player(false))
    await flush()
    expect(harness.requests).toHaveLength(2)
    harness.requests[1]!.resolve(player(false))
    await manualRefresh

    expect(harness.activeTimers()).toHaveLength(1)
    expect(harness.activeTimers()[0]?.delay).toBe(5000)
  })

  test("suppresses late successful samples after disposal", async () => {
    const harness = createHarness({ samples: [] })
    const pending = harness.requests[0]!
    harness.controller.dispose()
    pending.resolve(player())
    await flush()

    expect(harness.mutations).toHaveLength(1)
    expect(harness.toasts).toHaveLength(0)
    expect(harness.activeTimers()).toHaveLength(0)
  })

  test("disposal drops pending catch-up work", async () => {
    const harness = createHarness({ samples: [] })
    const pending = harness.requests[0]!
    harness.emit()
    harness.controller.dispose()
    pending.resolve(player())
    await flush()

    expect(harness.requests).toHaveLength(1)
    expect(harness.activeTimers()).toHaveLength(0)
    expect(harness.mutations).toHaveLength(1)
  })
})

const paused: PlayerState = {
  is_playing: false,
  progress_ms: 4_000,
  shuffle: false,
  repeat: "off",
  device: null,
  track: {
    id: "track",
    uri: "track",
    name: "Track",
    artists: "Artist",
    album: "Album",
    duration_ms: 10_000,
    artwork: null,
  },
  fetched_at: 1_000,
}

test("optimistic resume updates playback state at command completion", () => {
  expect(optimisticPlayerState(paused, true, 8_000)).toMatchObject({
    is_playing: true,
    progress_ms: 4_000,
    fetched_at: 8_000,
  })
})

test("optimistic pause freezes live progress before provider reconciliation", () => {
  expect(
    optimisticPlayerState({ ...paused, is_playing: true }, false, 2_500),
  ).toMatchObject({
    is_playing: false,
    progress_ms: 5_500,
    fetched_at: 2_500,
  })
})

test("optimistic seek clamps and preserves playback state", () => {
  expect(optimisticSeekPlayerState(paused, 20_000, 8_000)).toMatchObject({
    is_playing: false,
    progress_ms: 10_000,
    fetched_at: 8_000,
  })
  expect(optimisticSeekPlayerState({ ...paused, track: null }, 5_000)).toEqual({
    ...paused,
    track: null,
  })
})
