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

type TransportIntent =
  | {
      kind: "play" | "pause" | "next" | "previous"
      resolves: Array<() => void>
    }
  | {
      kind: "seek"
      positionMs: number
      resolves: Array<() => void>
    }

type TransportIntentInput =
  | { kind: "play" | "pause" | "next" | "previous" }
  | { kind: "seek"; positionMs: number }

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
  let lifecycleGeneration = 0
  let sampling = false
  let pendingSample = false
  let sampleRequestSequence = 0
  let samplingPromise: Promise<void> | null = null
  let transportRevision = 0
  let pendingIntents: TransportIntent[] = []
  let activeIntent: TransportIntent | null = null
  let errorFromTransport = false

  const isActive = () => !disposed

  const setError = (message: string | null, fromTransport = false) => {
    if (!isActive()) return
    errorFromTransport = message !== null && fromTransport
    setSession((d) => {
      d.error = message
    })
  }

  const updateLoading = () => {
    if (!isActive()) return
    const unfinished =
      (activeIntent?.resolves.length ?? 0) +
      pendingIntents.reduce(
        (count, intent) => count + intent.resolves.length,
        0,
      )
    setSession((d) => {
      d.loading = unfinished > 0
    })
  }

  const settleIntent = (intent: TransportIntent) => {
    for (const resolve of intent.resolves.splice(0)) resolve()
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
    sampleRequestSequence++
    stopPoll()
    if (sampling) {
      pendingSample = true
      return samplingPromise ?? Promise.resolve()
    }

    sampling = true
    const drain = (async () => {
      try {
        do {
          pendingSample = false
          const generation = lifecycleGeneration
          const requestSequence = sampleRequestSequence
          const revision = transportRevision
          try {
            const sampled = await backend.player()
            if (!isActive() || generation !== lifecycleGeneration) continue
            if (
              requestSequence === sampleRequestSequence &&
              revision === transportRevision
            ) {
              const player = mergePlayerPresentation(session.player, sampled)
              setSession((d) => {
                d.player = player
                if (!errorFromTransport) d.error = null
              })
            }
          } catch (e) {
            if (
              isActive() &&
              generation === lifecycleGeneration &&
              requestSequence === sampleRequestSequence &&
              revision === transportRevision
            ) {
              setError(errMsg(e))
            }
          }
        } while (isActive() && pendingSample)
      } finally {
        sampling = false
        if (isActive()) schedulePoll()
      }
    })()
    samplingPromise = drain
    void drain.then(() => {
      if (samplingPromise === drain) samplingPromise = null
    })
    return drain
  }

  const refreshAll = () => requestRefresh()

  const openApp = async () => {
    if (!isActive()) return
    try {
      openNowPlayingApp()
      context.ui.toast.show({
        title: "Music",
        message: "Play in any app — the sidebar uses system media",
        variant: "info",
      })
      await dependencies.delay(400)
      if (!isActive()) return
      await requestRefresh()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const scheduleReconciliation = (delay: number) => {
    void dependencies.delay(delay).then(
      () => {
        if (isActive()) void requestRefresh()
      },
      () => {},
    )
  }

  const runTransport = () => {
    if (!isActive() || activeIntent || pendingIntents.length === 0) return
    const intent = pendingIntents.shift()!
    activeIntent = intent
    const generation = lifecycleGeneration
    const command = Promise.resolve().then(() => {
      // Disposal can happen before this deferred runner turn starts.
      if (!isActive() || generation !== lifecycleGeneration) return
      return intent.kind === "play"
        ? backend.play()
        : intent.kind === "pause"
          ? backend.pause!()
          : intent.kind === "seek"
            ? backend.seek!(intent.positionMs)
            : intent.kind === "next"
              ? backend.next!()
              : backend.previous!()
    })

    void Promise.resolve(command)
      .then(
        () => {
          if (!isActive() || generation !== lifecycleGeneration) return
          transportRevision++
          setError(null)
          if (intent.kind === "play" || intent.kind === "pause") {
            setSession((d) => {
              d.player = optimisticPlayerState(d.player, intent.kind === "play")
            })
          } else if (intent.kind === "seek") {
            setSession((d) => {
              d.player = optimisticSeekPlayerState(d.player, intent.positionMs)
            })
          }
          scheduleReconciliation(
            intent.kind === "next" || intent.kind === "previous" ? 150 : 120,
          )
        },
        (error) => {
          if (!isActive() || generation !== lifecycleGeneration) return
          const message = errMsg(error)
          setError(message, true)
          context.ui.toast.show({ title: "Music", message, variant: "error" })
          scheduleReconciliation(0)
        },
      )
      .then(() => {
        if (activeIntent === intent) activeIntent = null
        settleIntent(intent)
        updateLoading()
        if (isActive()) queueMicrotask(runTransport)
      })
  }

  const enqueueTransport = (intent: TransportIntentInput) => {
    if (!isActive()) return Promise.resolve()
    if (
      (intent.kind === "pause" && !backend.pause) ||
      (intent.kind === "seek" && !backend.seek) ||
      (intent.kind === "next" && !backend.next) ||
      (intent.kind === "previous" && !backend.previous)
    ) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      if (intent.kind === "seek") {
        const tail = pendingIntents.at(-1)
        if (tail?.kind === "seek") {
          tail.positionMs = intent.positionMs
          tail.resolves.push(resolve)
        } else {
          pendingIntents.push({ ...intent, resolves: [resolve] })
        }
      } else {
        pendingIntents.push({ ...intent, resolves: [resolve] })
      }
      updateLoading()
      runTransport()
    })
  }

  const precedingPlaybackTarget = () => {
    const intents = activeIntent
      ? [activeIntent, ...pendingIntents]
      : pendingIntents
    for (let index = intents.length - 1; index >= 0; index--) {
      const intent = intents[index]!
      if (intent.kind === "play") return true
      if (intent.kind === "pause") return false
    }
    return !!session.player?.is_playing
  }

  const playPause = () => {
    const kind = precedingPlaybackTarget() ? "pause" : "play"
    return enqueueTransport({ kind })
  }

  const seek = (positionMs: number) => {
    const target = seekTarget(positionMs, session.player?.track?.duration_ms)
    if (!session.player?.track || !backend.seek || target === null)
      return Promise.resolve()
    return enqueueTransport({ kind: "seek", positionMs: target })
  }

  const next = () =>
    backend.next ? enqueueTransport({ kind: "next" }) : Promise.resolve()

  const prev = () =>
    backend.previous
      ? enqueueTransport({ kind: "previous" })
      : Promise.resolve()

  eventDisposer =
    backend.subscribe?.((event) => {
      if (!isActive()) return
      if (event?.type === "snapshot") {
        setSession((d) => {
          d.player = event.state
          d.error = null
        })
        errorFromTransport = false
        // A snapshot is authoritative, so older provider reads cannot restore it.
        sampleRequestSequence++
        pendingSample = false
        schedulePoll()
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
      lifecycleGeneration++
      eventDisposer?.()
      eventDisposer = null
      presentationDisposer?.()
      presentationDisposer = null
      stopPoll()
      pendingSample = false
      for (const intent of pendingIntents) settleIntent(intent)
      pendingIntents = []
      if (activeIntent) settleIntent(activeIntent)
      if (session.loading) {
        setSession((d) => {
          d.loading = false
        })
      }
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
