/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import {
  createSystemMedia,
  hasMediaControl,
  hasNowPlayingCli,
  openNowPlayingApp,
} from "./system-media.ts"
import { isMac, type MusicBackend, type PlayerState } from "./types.ts"
import { FooterDock, type UiState } from "./ui.tsx"

const POLL_PLAYING_MS = 3000
const POLL_IDLE_MS = 8000

type Context = Plugin.Context

type SessionStore = UiState

type Controller = {
  session: SessionStore
  toggleExpand: () => void
  expand: () => void
  collapse: () => void
  openApp: () => Promise<void>
  refreshAll: () => Promise<void>
  playPause: () => Promise<void>
  next: () => Promise<void>
  prev: () => Promise<void>
  dispose: () => void
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message)
  }
  return String(e)
}

function createController(context: Context): Controller {
  const [session, setSession] = context.storage.memory<SessionStore>(
    "music-player.session.v4",
    {
      initial: {
        loading: false,
        error: null,
        query: "",
        results: [],
        selected: 0,
        devices: [],
        player: null,
        view: "now",
        expanded: false,
      },
    },
  )

  const backend: MusicBackend = createSystemMedia()

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
    if (busy) return
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
      setSession((d) => {
        d.loading = false
      })
    }
  }

  /** Keep progress monotonic; never let a poll un-pause a held pause. */
  const mergePlayer = (
    prev: PlayerState | null,
    next: PlayerState | null,
  ): PlayerState | null => {
    if (!next) return next
    if (!prev?.track || !next.track) return next
    if (
      prev.track.id !== next.track.id &&
      prev.track.name !== next.track.name
    ) {
      return next
    }

    const now = Date.now()
    const prevLive = prev.is_playing
      ? prev.progress_ms + (now - prev.fetched_at)
      : prev.progress_ms

    // Same track: ignore a sudden drop to ~0 while still playing.
    if (
      next.is_playing &&
      prevLive > 2000 &&
      next.progress_ms < 500 &&
      next.track.duration_ms > 0 &&
      next.progress_ms + 3000 < prevLive
    ) {
      return {
        ...next,
        progress_ms: Math.min(next.track.duration_ms, Math.round(prevLive)),
        fetched_at: now,
      }
    }
    return next
  }

  const refreshPlayer = async () => {
    if (polling) return
    polling = true
    try {
      const player = mergePlayer(session.player, await backend.player())
      if (disposed) return
      setSession((d) => {
        d.player = player
        d.devices = player?.device ? [player.device] : []
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
    if (pollTimer) clearTimeout(pollTimer)
    const playing = !!session.player?.is_playing
    const idle = !session.player?.track
    const ms = playing ? POLL_PLAYING_MS : idle ? POLL_IDLE_MS : 5000
    pollTimer = setTimeout(() => {
      void refreshPlayer().finally(() => schedulePoll())
    }, ms)
  }

  const startPoll = () => {
    if (pollTimer) return
    schedulePoll()
  }

  const stopPoll = () => {
    if (!pollTimer) return
    clearTimeout(pollTimer)
    pollTimer = null
  }

  const expand = () => {
    setSession((d) => {
      d.expanded = true
    })
    void refreshAll()
  }

  const collapse = () => {
    setSession((d) => {
      d.expanded = false
    })
  }

  const toggleExpand = () => {
    if (session.expanded) collapse()
    else expand()
  }

  const openApp = async () => {
    await withLoading(async () => {
      openNowPlayingApp()
      context.ui.toast.show({
        title: "Music",
        message: "Play in any app — footer uses system media",
        variant: "info",
      })
      await Bun.sleep(400)
      await refreshPlayer()
    }, false)
  }

  const playPause = async () => {
    await withLoading(async () => {
      const p = session.player
      if (p?.is_playing) await backend.pause?.()
      else await backend.play()
      await Bun.sleep(120)
      await refreshPlayer()
    })
  }

  const next = async () => {
    await withLoading(async () => {
      await backend.next?.()
      await Bun.sleep(150)
      await refreshPlayer()
    })
  }

  const prev = async () => {
    await withLoading(async () => {
      await backend.previous?.()
      await Bun.sleep(150)
      await refreshPlayer()
    })
  }

  void refreshPlayer()
  startPoll()

  return {
    session,
    toggleExpand,
    expand,
    collapse,
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

function Host(props: { context: Context; ctrl: Controller }) {
  const { context, ctrl } = props
  const expanded = () => ctrl.session.expanded

  context.keymap.layer(() => ({
    mode: "global",
    priority: 200,
    commands: [
      {
        id: "music.toggle",
        title: "Toggle music footer",
        group: "Music",
        bind: "ctrl+shift+m",
        palette: true,
        slash: { name: "music" },
        run: () => ctrl.toggleExpand(),
      },
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

  context.keymap.layer(() => ({
    mode: "global",
    enabled: expanded,
    priority: 750,
    commands: [
      {
        id: "music.collapse",
        bind: "escape",
        title: "Collapse",
        group: "Music",
        run: () => ctrl.collapse(),
      },
      {
        id: "music.refresh",
        bind: "shift+r",
        title: "Refresh",
        group: "Music",
        run: () => void ctrl.refreshAll(),
      },
      {
        id: "music.playpause.footer",
        bind: "space",
        title: "Play / pause",
        group: "Music",
        run: () => void ctrl.playPause(),
      },
      {
        id: "music.next.footer",
        bind: "right",
        title: "Next",
        group: "Music",
        run: () => void ctrl.next(),
      },
      {
        id: "music.prev.footer",
        bind: "left",
        title: "Previous",
        group: "Music",
        run: () => void ctrl.prev(),
      },
    ],
  }))

  return (
    <FooterDock
      context={context}
      state={ctrl.session}
      onToggleExpand={ctrl.toggleExpand}
      onPlayPause={() => void ctrl.playPause()}
      onNext={() => void ctrl.next()}
      onPrev={() => void ctrl.prev()}
      onRefresh={() => void ctrl.refreshAll()}
      onOpenApp={() => void ctrl.openApp()}
    />
  )
}

export default Plugin.define({
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
        message: "brew tap ungive/media-control && brew install media-control",
        variant: "warning",
      })
    }

    const ctrl = createController(context)
    const unsub = context.ui.slot("app", () => (
      <Host context={context} ctrl={ctrl} />
    ))
    return () => {
      ctrl.dispose()
      unsub()
    }
  },
})
