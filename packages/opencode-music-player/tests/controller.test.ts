import { describe, expect, test } from "bun:test"
import type { MusicBackend, PlayerState } from "../types.ts"
import { createController } from "../index.tsx"

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
  options: { subscribe?: boolean; samples?: PlayerState[] } = {},
) {
  const timers: Array<{
    callback: () => void
    delay: number
    active: boolean
  }> = []
  const samples = options.samples ?? [player()]
  const requests: Array<Deferred<PlayerState | null>> = []
  let listener: (() => void) | null = null
  let subscriptions = 0
  let subscriptionDisposals = 0
  const backend: MusicBackend = {
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
    play: async () => {},
  }
  if (options.subscribe !== false) {
    backend.subscribe = (nextListener) => {
      subscriptions++
      listener = nextListener
      return () => {
        subscriptionDisposals++
      }
    }
  }
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
    delay: async () => {},
  })
  return {
    controller,
    emit: () => listener?.(),
    mutations,
    requests,
    subscriptions: () => subscriptions,
    subscriptionDisposals: () => subscriptionDisposals,
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
