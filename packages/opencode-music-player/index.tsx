/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import {
  createSystemMedia,
  hasMediaControl,
  hasNowPlayingCli,
  openNowPlayingApp,
} from "./system-media.ts"
import {
  isMac,
  mergeArtworkCompletion,
  mergePlayerPresentation,
  type MusicBackend,
} from "./types.ts"
import { CompactPlayer, SidebarPlayer, type UiState } from "./ui.tsx"

const POLL_PLAYING_MS = 3000
const POLL_PAUSED_MS = 5000
const POLL_IDLE_MS = 8000

type Context = Plugin.Context

type SessionStore = UiState

export type Controller = {
  session: SessionStore
  openApp: () => Promise<void>
  refreshAll: () => Promise<void>
  playPause: () => Promise<void>
  seek: (positionMs: number) => Promise<void>
  next: () => Promise<void>
  prev: () => Promise<void>
  dispose: () => void
}

export type ControllerDependencies = {
  createBackend: () => MusicBackend
  scheduleTimeout: typeof setTimeout
  clearScheduledTimeout: typeof clearTimeout
  delay: (ms: number) => Promise<void>
}

/** Apply successful transport state before the delayed provider refresh. */
export function optimisticPlayerState(
  player: SessionStore["player"],
  playing: boolean,
  now = Date.now(),
): SessionStore["player"] {
  if (!player) return player
  const progress = player.is_playing
    ? Math.min(
        player.track?.duration_ms || Number.POSITIVE_INFINITY,
        Math.max(0, player.progress_ms + (now - player.fetched_at)),
      )
    : player.progress_ms
  return {
    ...player,
    progress_ms: progress,
    is_playing: playing,
    fetched_at: now,
  }
}

export function optimisticSeekPlayerState(
  player: SessionStore["player"],
  positionMs: number,
  now = Date.now(),
): SessionStore["player"] {
  const duration = player?.track?.duration_ms
  const target = seekTarget(positionMs, duration)
  if (!player?.track || target === null) return player
  return {
    ...player,
    progress_ms: target,
    fetched_at: now,
  }
}

function seekTarget(positionMs: number, durationMs?: number): number | null {
  if (
    !Number.isFinite(positionMs) ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return null
  }
  return Math.max(0, Math.min(durationMs, Math.round(positionMs)))
}

const controllerDependencies: ControllerDependencies = {
  createBackend: createSystemMedia,
  scheduleTimeout: setTimeout,
  clearScheduledTimeout: clearTimeout,
  delay: Bun.sleep,
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message)
  }
  return String(e)
}

export function createController(
  context: Context,
  dependencies: ControllerDependencies = controllerDependencies,
): Controller {
  const [session, setSession] = context.storage.memory<SessionStore>(
    "music-player.session.v5",
    {
      initial: {
        loading: false,
        error: null,
        player: null,
      },
    },
  )

  const backend = dependencies.createBackend()

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let eventDisposer: (() => void) | null = null
  let presentationDisposer: (() => void) | null = null
  let disposed = false
  let busy = false
  let sampling = false
  let pendingRefresh = false
  let drainPromise: Promise<void> | null = null
  let transportRevision = 0
  let pendingSeekRevision: number | null = null
  let seekBusy = false

  const isActive = () => !disposed

  const setError = (message: string | null) => {
    if (!isActive()) return
    setSession((d) => {
      d.error = message
    })
  }

  const withLoading = async (fn: () => Promise<void>, toast = true) => {
    if (!isActive() || busy) return
    busy = true
    setSession((d) => {
      d.loading = true
      d.error = null
    })
    try {
      await fn()
    } catch (e) {
      if (!isActive()) return
      const message = errMsg(e)
      setError(message)
      if (toast)
        context.ui.toast.show({ title: "Music", message, variant: "error" })
    } finally {
      busy = false
      if (isActive()) {
        setSession((d) => {
          d.loading = false
        })
      }
    }
  }

  const stopPoll = () => {
    if (!pollTimer) return
    dependencies.clearScheduledTimeout(pollTimer)
    pollTimer = null
  }

  const schedulePoll = () => {
    if (!isActive()) return
    stopPoll()
    const playing = !!session.player?.is_playing
    const idle = !session.player?.track
    const ms = playing ? POLL_PLAYING_MS : idle ? POLL_IDLE_MS : POLL_PAUSED_MS
    pollTimer = dependencies.scheduleTimeout(() => {
      pollTimer = null
      void requestRefresh()
    }, ms)
  }

  const requestRefresh = (): Promise<void> => {
    if (!isActive()) return Promise.resolve()
    pendingRefresh = true
    stopPoll()
    if (sampling) return drainPromise ?? Promise.resolve()

    sampling = true
    const drain = (async () => {
      try {
        do {
          pendingRefresh = false
          try {
            const revision = transportRevision
            const sampled = await backend.player()
            if (!isActive()) return
            if (
              revision === transportRevision &&
              pendingSeekRevision === null
            ) {
              const player = mergePlayerPresentation(session.player, sampled)
              setSession((d) => {
                d.player = player
                d.error = null
              })
            }
          } catch (e) {
            if (isActive()) setError(errMsg(e))
          }
        } while (isActive() && pendingRefresh)
      } finally {
        sampling = false
        if (isActive()) schedulePoll()
      }
    })()
    drainPromise = drain
    void drain.finally(() => {
      if (drainPromise === drain) drainPromise = null
    })
    return drain
  }

  const refreshAll = async () => {
    await withLoading(async () => {
      await requestRefresh()
    }, false)
  }

  const openApp = async () => {
    await withLoading(async () => {
      openNowPlayingApp()
      context.ui.toast.show({
        title: "Music",
        message: "Play in any app — the sidebar uses system media",
        variant: "info",
      })
      await dependencies.delay(400)
      if (!isActive()) return
      await requestRefresh()
    }, false)
  }

  const playPause = async () => {
    await withLoading(async () => {
      const p = session.player
      if (p?.is_playing) await backend.pause?.()
      else await backend.play()
      if (!isActive()) return
      transportRevision++
      setSession((d) => {
        d.player = optimisticPlayerState(d.player, !p?.is_playing)
      })
      await dependencies.delay(120)
      if (!isActive()) return
      await requestRefresh()
    })
  }

  const seek = async (positionMs: number) => {
    const previous = session.player
    const target = seekTarget(positionMs, previous?.track?.duration_ms)
    if (!previous?.track || !backend.seek || target === null || seekBusy) return

    seekBusy = true
    setError(null)
    transportRevision++
    const revision = transportRevision
    pendingSeekRevision = revision
    setSession((d) => {
      d.player = optimisticSeekPlayerState(d.player, target)
    })

    try {
      await backend.seek(target)
      if (!isActive()) return
      if (revision !== transportRevision) {
        if (pendingSeekRevision === revision) pendingSeekRevision = null
        await requestRefresh()
        return
      }
      await dependencies.delay(120)
      if (!isActive()) return
      if (revision !== transportRevision) {
        if (pendingSeekRevision === revision) pendingSeekRevision = null
        await requestRefresh()
        return
      }

      transportRevision++
      pendingSeekRevision = null
      await requestRefresh()
    } catch (error) {
      if (!isActive()) return
      if (pendingSeekRevision === revision) pendingSeekRevision = null
      const superseded = revision !== transportRevision
      if (!superseded) {
        transportRevision++
        setSession((d) => {
          d.player = previous
        })
      }
      const message = errMsg(error)
      context.ui.toast.show({ title: "Music", message, variant: "error" })
      await requestRefresh()
      setError(message)
    } finally {
      if (pendingSeekRevision === revision) pendingSeekRevision = null
      seekBusy = false
    }
  }

  const next = async () => {
    await withLoading(async () => {
      await backend.next?.()
      if (!isActive()) return
      transportRevision++
      await dependencies.delay(150)
      if (!isActive()) return
      await requestRefresh()
    })
  }

  const prev = async () => {
    await withLoading(async () => {
      await backend.previous?.()
      if (!isActive()) return
      transportRevision++
      await dependencies.delay(150)
      if (!isActive()) return
      await requestRefresh()
    })
  }

  eventDisposer =
    backend.subscribe?.((event) => {
      if (!isActive()) return
      if (event?.type === "snapshot") {
        setSession((d) => {
          d.player = event.state
          d.error = null
        })
        return
      }
      void requestRefresh()
    }) ?? null
  presentationDisposer =
    backend.subscribePresentation?.((event) => {
      if (!isActive()) return
      setSession((d) => {
        d.player = mergeArtworkCompletion(d.player, event)
      })
    }) ?? null
  void refreshAll()

  return {
    session,
    openApp,
    refreshAll,
    playPause,
    seek,
    next,
    prev,
    dispose: () => {
      if (disposed) return
      disposed = true
      eventDisposer?.()
      eventDisposer = null
      presentationDisposer?.()
      presentationDisposer = null
      stopPoll()
      pendingRefresh = false
    },
  }
}

function AppHost(props: { context: Context; ctrl: Controller }) {
  const { context, ctrl } = props

  context.keymap.layer(() => ({
    mode: "global",
    priority: 200,
    commands: [
      {
        id: "music.playpause",
        title: "Play / pause",
        group: "Music",
        bind: "ctrl+shift+p",
        palette: true,
        run: () => void ctrl.playPause(),
      },
      {
        id: "music.next",
        title: "Next track",
        group: "Music",
        bind: "ctrl+shift+right",
        palette: true,
        run: () => void ctrl.next(),
      },
      {
        id: "music.prev",
        title: "Previous track",
        group: "Music",
        bind: "ctrl+shift+left",
        palette: true,
        run: () => void ctrl.prev(),
      },
      {
        id: "music.open-app",
        title: "Open music site",
        group: "Music",
        palette: true,
        slash: { name: "music-app" },
        run: () => void ctrl.openApp(),
      },
    ],
  }))

  return (
    <CompactPlayer
      context={context}
      state={ctrl.session}
      onPlayPause={() => void ctrl.playPause()}
      onSeek={(positionMs) => void ctrl.seek(positionMs)}
    />
  )
}

export function createMusicPlayerPlugin(options?: {
  createController?: (context: Context) => Controller
}) {
  return Plugin.define({
    id: "music-player",
    setup(context: Context) {
      if (!isMac()) {
        context.ui.toast.show({
          title: "Music",
          message: "System media control is macOS-only",
          variant: "warning",
        })
      } else if (!hasMediaControl() && !hasNowPlayingCli()) {
        context.ui.toast.show({
          title: "Music",
          message:
            "brew tap ungive/media-control && brew install media-control",
          variant: "warning",
        })
      }

      const ctrl =
        options?.createController?.(context) ?? createController(context)
      const unsubApp = context.ui.slot("app", () => (
        <AppHost context={context} ctrl={ctrl} />
      ))
      const unsubSidebar = context.ui.slot("sidebar.content", () => (
        <SidebarPlayer
          context={context}
          state={ctrl.session}
          onPlayPause={() => void ctrl.playPause()}
          onNext={() => void ctrl.next()}
          onPrev={() => void ctrl.prev()}
          onSeek={(positionMs) => void ctrl.seek(positionMs)}
        />
      ))
      return () => {
        unsubApp()
        unsubSidebar()
        ctrl.dispose()
      }
    },
  })
}

export default createMusicPlayerPlugin()
