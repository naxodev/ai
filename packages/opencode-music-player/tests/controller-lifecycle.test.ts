import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createController } from "../index.tsx"
import { CompactPlayer } from "../ui.tsx"

const player = (id: string) => ({
  track: {
    id,
    name: id,
    artists: "Artist",
    album: "Album",
    duration_ms: 1000,
    artwork: null,
  },
  is_playing: true,
  progress_ms: 0,
  fetched_at: Date.now(),
})

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

test("a completed poll leaves one timeout and view mounts schedule none", async () => {
  let reads = 0
  let nextTimer = 0
  const pending = new Map<number, () => void>()
  const cleared: number[] = []
  const session = { loading: false, error: null, player: null as any }
  const context = {
    storage: {
      memory: () => [
        session,
        (update: (state: typeof session) => void) => update(session),
      ],
    },
    ui: { toast: { show: () => {} } },
    theme,
  }
  const controller = createController(context as any, {
    createBackend: () =>
      ({
        player: async () => player(`read-${++reads}`),
      }) as any,
    scheduleTimeout: ((callback: () => void) => {
      const timer = ++nextTimer
      pending.set(timer, callback)
      return timer
    }) as any,
    clearScheduledTimeout: ((timer: number) => {
      cleared.push(timer)
      pending.delete(timer)
    }) as any,
    delay: async () => {},
  })

  await controller.refreshAll()
  expect(pending.size).toBe(1)
  const [timer, runPoll] = pending.entries().next().value!
  pending.delete(timer)
  runPoll()
  await Promise.resolve()
  await Promise.resolve()
  expect(reads).toBe(3)
  expect(pending.size).toBe(1)

  const compact = await testRender(
    () =>
      CompactPlayer({
        context: context as any,
        state: session,
        onPlayPause: () => {},
        onSeek: () => {},
      }),
    { width: 40, height: 4 },
  )
  expect(pending.size).toBe(1)
  expect(nextTimer).toBe(2)

  compact.renderer.destroy()
  controller.dispose()
  expect(cleared).toEqual([2])
  expect(pending.size).toBe(0)
})

test("disposal clears the sole poll and ignores an in-flight refresh", async () => {
  let resolvePlayer: ((value: unknown) => void) | undefined
  let reads = 0
  const scheduled: Array<() => void> = []
  const cleared: number[] = []
  const session = { loading: false, error: null, player: null as any }
  const context = {
    storage: {
      memory: () => [
        session,
        (update: (state: typeof session) => void) => update(session),
      ],
    },
    ui: { toast: { show: () => {} } },
  }

  const controller = createController(context as any, {
    createBackend: () =>
      ({
        player: () => {
          reads++
          return new Promise((resolve) => {
            resolvePlayer = resolve
          })
        },
      }) as any,
    scheduleTimeout: ((callback: () => void) => {
      scheduled.push(callback)
      return scheduled.length
    }) as any,
    clearScheduledTimeout: ((timer: number) => cleared.push(timer)) as any,
    delay: async () => {},
  })

  expect(reads).toBe(1)
  // No fallback poll competes with the provider sample already in flight.
  expect(scheduled).toHaveLength(0)
  controller.dispose()
  expect(cleared).toEqual([])

  resolvePlayer?.({
    track: { id: "late", name: "Late", artists: "Artist", duration_ms: 1 },
    is_playing: true,
    progress_ms: 0,
    fetched_at: Date.now(),
  })
  await Promise.resolve()
  await Promise.resolve()

  expect(session.player).toBeNull()
  expect(scheduled).toHaveLength(0)
})

test("disposal cancels command callers and suppresses late command work", async () => {
  let rejectPlay: ((reason: unknown) => void) | undefined
  let playCalls = 0
  let nextCalls = 0
  let coreDisposals = 0
  let presentationDisposals = 0
  const toasts: unknown[] = []
  const session = {
    loading: false,
    error: null,
    player: player("paused"),
  }
  session.player.is_playing = false
  const context = {
    storage: {
      memory: () => [
        session,
        (update: (state: typeof session) => void) => update(session),
      ],
    },
    ui: { toast: { show: (toast: unknown) => toasts.push(toast) } },
  }
  const controller = createController(context as any, {
    createBackend: () =>
      ({
        player: async () => session.player,
        play: () => {
          playCalls++
          return new Promise<void>((_resolve, reject) => {
            rejectPlay = reject
          })
        },
        next: async () => {
          nextCalls++
        },
        subscribe: () => () => {
          coreDisposals++
        },
        subscribePresentation: () => () => {
          presentationDisposals++
        },
      }) as any,
    scheduleTimeout: (() => 1) as any,
    clearScheduledTimeout: (() => {}) as any,
    delay: async () => {},
  })
  await controller.refreshAll()
  const active = controller.playPause()
  await Promise.resolve()
  const queued = controller.next()

  controller.dispose()
  controller.dispose()
  await Promise.all([active, queued])

  expect(playCalls).toBe(1)
  expect(nextCalls).toBe(0)
  expect(session.loading).toBe(false)
  expect(coreDisposals).toBe(1)
  expect(presentationDisposals).toBe(1)

  rejectPlay?.(new Error("late failure"))
  await Promise.resolve()
  await Promise.resolve()

  expect(session.player.is_playing).toBe(false)
  expect(toasts).toHaveLength(0)

  await controller.next()
  await controller.playPause()
  expect(playCalls).toBe(1)
  expect(nextCalls).toBe(0)
})

test("disposal before the deferred runner turn starts no backend command", async () => {
  let plays = 0
  const session = { loading: false, error: null, player: player("paused") }
  session.player.is_playing = false
  const context = {
    storage: {
      memory: () => [
        session,
        (update: (state: typeof session) => void) => update(session),
      ],
    },
    ui: { toast: { show: () => {} } },
  }
  const controller = createController(context as any, {
    createBackend: () =>
      ({
        player: async () => session.player,
        play: async () => {
          plays++
        },
      }) as any,
    scheduleTimeout: (() => 1) as any,
    clearScheduledTimeout: (() => {}) as any,
    delay: async () => {},
  })
  await controller.refreshAll()

  const command = controller.playPause()
  controller.dispose()
  await command
  await Promise.resolve()

  expect(plays).toBe(0)
  expect(session.loading).toBe(false)
})

test("post-disposal openApp resolves before opening, toasting, delaying, or refreshing", async () => {
  const session = { loading: false, error: null, player: null as any }
  const toasts: unknown[] = []
  let delayCalls = 0
  let playerCalls = 0
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => undefined as never)
  const context = {
    storage: {
      memory: () => [
        session,
        (update: (state: typeof session) => void) => update(session),
      ],
    },
    ui: { toast: { show: (toast: unknown) => toasts.push(toast) } },
  }
  const controller = createController(context as any, {
    createBackend: () =>
      ({
        player: async () => {
          playerCalls++
          return null
        },
      }) as any,
    scheduleTimeout: (() => 1) as any,
    clearScheduledTimeout: (() => {}) as any,
    delay: async () => {
      delayCalls++
    },
  })

  try {
    await Promise.resolve()
    const initialPlayerCalls = playerCalls
    controller.dispose()
    await controller.openApp()

    expect(spawn).not.toHaveBeenCalled()
    expect(toasts).toHaveLength(0)
    expect(delayCalls).toBe(0)
    expect(playerCalls).toBe(initialPlayerCalls)
  } finally {
    spawn.mockRestore()
  }
})
