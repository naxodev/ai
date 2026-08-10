/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { mergePlayer } from "@naxodev/music-core"
import {
  createSystemMedia,
  hasMediaControl,
  hasNowPlayingCli,
  openNowPlayingApp,
} from "./system-media.ts"
import { isMac, type MusicBackend } from "./types.ts"
import { CompactPlayer, SidebarPlayer, type UiState } from "./ui.tsx"

const POLL_PLAYING_MS = 3000
const POLL_IDLE_MS = 8000

type Context = Plugin.Context

type SessionStore = UiState

export type Controller = {
  session: SessionStore
  openApp: () => Promise<void>
  refreshAll: () => Promise<void>
  playPause: () => Promise<void>
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
  let disposed = false
  let busy = false
  let polling = false

  const setError = (message: string | null) => {
    setSession((d) => {
      d.error = message
    })
  }

  const withLoading = async (fn: () => Promise<void>, toast = true) => {
    if (busy || disposed) return
    busy = true
    setSession((d) => {
      d.loading = true
      d.error = null
    })
    try {
      await fn()
    } catch (e) {
      const message = errMsg(e)
      setError(message)
      if (toast)
        context.ui.toast.show({ title: "Music", message, variant: "error" })
    } finally {
      busy = false
      if (!disposed) {
        setSession((d) => {
          d.loading = false
        })
      }
    }
  }

  const refreshPlayer = async () => {
    if (polling) return
    polling = true
    try {
      const player = mergePlayer(session.player, await backend.player())
      if (disposed) return
      setSession((d) => {
        d.player = player
      })
    } catch (e) {
      if (!disposed) setError(errMsg(e))
    } finally {
      polling = false
    }
  }

  const refreshAll = async () => {
    await withLoading(async () => {
      await refreshPlayer()
    }, false)
  }

  const schedulePoll = () => {
    if (disposed) return
    if (pollTimer) dependencies.clearScheduledTimeout(pollTimer)
    const playing = !!session.player?.is_playing
    const idle = !session.player?.track
    const ms = playing ? POLL_PLAYING_MS : idle ? POLL_IDLE_MS : 5000
    pollTimer = dependencies.scheduleTimeout(() => {
      pollTimer = null
      void refreshPlayer().finally(() => schedulePoll())
    }, ms)
  }

  const startPoll = () => {
    if (pollTimer) return
    schedulePoll()
  }

  const stopPoll = () => {
    if (!pollTimer) return
    dependencies.clearScheduledTimeout(pollTimer)
    pollTimer = null
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
      await refreshPlayer()
    }, false)
  }

  const playPause = async () => {
    await withLoading(async () => {
      const p = session.player
      if (p?.is_playing) await backend.pause?.()
      else await backend.play()
      await dependencies.delay(120)
      await refreshPlayer()
    })
  }

  const next = async () => {
    await withLoading(async () => {
      await backend.next?.()
      await dependencies.delay(150)
      await refreshPlayer()
    })
  }

  const prev = async () => {
    await withLoading(async () => {
      await backend.previous?.()
      await dependencies.delay(150)
      await refreshPlayer()
    })
  }

  void refreshAll()
  startPoll()

  return {
    session,
    openApp,
    refreshAll,
    playPause,
    next,
    prev,
    dispose: () => {
      disposed = true
      stopPoll()
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

  return <CompactPlayer context={context} state={ctrl.session} />
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
