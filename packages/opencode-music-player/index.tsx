/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { createSessionSystemMedia, openNowPlayingApp } from "./system-media.ts"
import {
  isMac,
  mergeArtworkCompletion,
  mergePlayerSnapshot,
  type SessionMedia,
} from "./types.ts"
import { CompactPlayer, SidebarPlayer, type UiState } from "./ui.tsx"

type Context = Plugin.Context
type SessionStore = UiState & { loadingOwners?: string[] }
type SeekIntent = {
  positionMs: number
  resolves: Array<() => void>
}

export type Controller = {
  session: SessionStore
  subscribe: (listener: (session: SessionStore) => void) => () => void
  openApp: () => Promise<void>
  refreshAll: () => Promise<void>
  playPause: () => Promise<void>
  seek: (positionMs: number) => Promise<void>
  next: () => Promise<void>
  prev: () => Promise<void>
  dispose: () => void
}

export type ControllerDependencies = {
  createSessionMedia: () => SessionMedia
}

function seekTarget(positionMs: number, durationMs?: number): number | null {
  if (
    !Number.isFinite(positionMs) ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  )
    return null
  return Math.max(0, Math.min(durationMs, Math.round(positionMs)))
}

const controllerDependencies: ControllerDependencies = {
  createSessionMedia: createSessionSystemMedia,
}

function errMsg(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error)
}

export function createController(
  context: Context,
  dependencies: ControllerDependencies = controllerDependencies,
): Controller {
  const [session, setSessionStore] = context.storage.memory<SessionStore>(
    "music-player.session.v6",
    {
      initial: {
        loading: false,
        loadingOwners: [],
        error: null,
        player: null,
      },
    },
  )
  const sessionListeners = new Set<(session: SessionStore) => void>()
  const setSession = (update: (draft: SessionStore) => void) => {
    setSessionStore(update)
    for (const listener of [...sessionListeners]) {
      try {
        listener(session)
      } catch {
        // One mounted presentation cannot block controller state.
      }
    }
  }
  const loadingOwner = crypto.randomUUID()
  const media = dependencies.createSessionMedia()
  let disposed = false
  let lifecycleGeneration = 0
  let eventDisposer: (() => void) | null = null
  let presentationDisposer: (() => void) | null = null
  let lifecycleError: {
    message: string | null
    source: "connection" | "provider" | "acquisition" | undefined
  } = { message: null, source: undefined }
  let transportError: string | null = null
  let receivedSnapshot = false
  let snapshotEpoch = 0
  let playbackIntent:
    | {
        readonly target: boolean
        readonly startedAtEpoch: number
        settled: boolean
      }
    | undefined
  let activeSeek: SeekIntent | null = null
  let latestSeek: SeekIntent | null = null
  const pending = new Set<() => void>()
  const isActive = () => !disposed

  const publishError = () => {
    if (!isActive()) return
    const message =
      lifecycleError.source === "connection" && lifecycleError.message
        ? lifecycleError.message
        : (transportError ?? lifecycleError.message)
    setSession((draft) => {
      draft.error = message
    })
  }
  const setLifecycleError = (
    message: string | null,
    source: "connection" | "provider" | "acquisition" | undefined,
  ) => {
    lifecycleError = { message, source }
    publishError()
  }
  const setTransportError = (message: string | null) => {
    transportError = message
    publishError()
  }
  const setLoadingOwner = (active: boolean) => {
    setSession((draft) => {
      const owners = new Set(draft.loadingOwners ?? [])
      if (active) owners.add(loadingOwner)
      else owners.delete(loadingOwner)
      draft.loadingOwners = [...owners]
      draft.loading = owners.size > 0
    })
  }
  const updateLoading = () => {
    if (isActive()) setLoadingOwner(pending.size > 0)
  }
  const settle = (resolve: () => void) => {
    if (!pending.delete(resolve)) return
    resolve()
    updateLoading()
  }

  const runCommand = (
    command: () => Promise<unknown>,
    onSettled?: (succeeded: boolean) => void,
  ) => {
    if (!isActive()) return Promise.resolve()
    const generation = lifecycleGeneration
    return new Promise<void>((resolve) => {
      pending.add(resolve)
      updateLoading()
      let result: Promise<unknown> | undefined
      try {
        result = command()
      } catch (error) {
        result = Promise.reject(error)
      }
      let succeeded = false
      void Promise.resolve(result)
        .then(
          () => {
            succeeded = true
            if (!isActive() || generation !== lifecycleGeneration) return
            if (transportError !== null) setTransportError(null)
          },
          (error) => {
            if (!isActive() || generation !== lifecycleGeneration) return
            const message = errMsg(error)
            setTransportError(message)
            context.ui.toast.show({ title: "Music", message, variant: "error" })
          },
        )
        .finally(() => {
          try {
            onSettled?.(succeeded)
          } finally {
            settle(resolve)
          }
        })
    })
  }

  const runSeek = (intent: SeekIntent) => {
    activeSeek = intent
    void runCommand(
      () => media.seek(intent.positionMs),
      () => {
        if (activeSeek !== intent) return
        activeSeek = null
        for (const resolve of intent.resolves) resolve()
        intent.resolves = []
        const next = latestSeek
        latestSeek = null
        if (isActive() && next) runSeek(next)
        else next?.resolves.splice(0).forEach((resolve) => resolve())
      },
    )
  }

  const refreshAll = async () => {
    if (!isActive()) return
    const generation = lifecycleGeneration
    try {
      const player = await media.player()
      if (!isActive() || generation !== lifecycleGeneration || receivedSnapshot)
        return
      setSession((draft) => {
        draft.player = player
      })
    } catch (error) {
      if (isActive() && generation === lifecycleGeneration)
        setTransportError(errMsg(error))
    }
  }

  const playPause = () => {
    const nextPlaying = !(
      playbackIntent?.target ?? !!session.player?.is_playing
    )
    const intent = {
      target: nextPlaying,
      startedAtEpoch: snapshotEpoch,
      settled: false,
    }
    playbackIntent = intent
    return runCommand(
      () => (nextPlaying ? media.play() : media.pause()),
      (succeeded) => {
        if (playbackIntent !== intent) return
        if (!succeeded) {
          playbackIntent = undefined
          return
        }
        intent.settled = true
        if (
          snapshotEpoch > intent.startedAtEpoch &&
          session.player?.is_playing === intent.target
        )
          playbackIntent = undefined
      },
    )
  }

  const seek = (positionMs: number) => {
    const target = seekTarget(positionMs, session.player?.track?.duration_ms)
    if (!session.player?.track || target === null || !isActive())
      return Promise.resolve()
    return new Promise<void>((resolve) => {
      if (activeSeek) {
        if (latestSeek) {
          latestSeek.positionMs = target
          latestSeek.resolves.push(resolve)
        } else {
          latestSeek = { positionMs: target, resolves: [resolve] }
        }
        return
      }
      runSeek({ positionMs: target, resolves: [resolve] })
    })
  }

  eventDisposer = media.subscribe((event) => {
    if (!isActive()) return
    if (event?.type === "snapshot") {
      receivedSnapshot = true
      snapshotEpoch++
      setSession((draft) => {
        draft.player = mergePlayerSnapshot(draft.player, event.state)
      })
      if (
        playbackIntent?.settled &&
        snapshotEpoch > playbackIntent.startedAtEpoch &&
        event.state.is_playing === playbackIntent.target
      )
        playbackIntent = undefined
      return
    }
    if (event?.type === "lifecycle") {
      // Lifecycle and transport feedback are retained independently. A
      // connection loss takes precedence, a transport failure temporarily
      // takes precedence over provider status, and clearing it restores the
      // latest daemon lifecycle state without requiring a repeated event.
      setLifecycleError(event.message, event.source)
      if (event.source === "connection" && event.message !== null)
        playbackIntent = undefined
      if (event.message !== null && latestSeek) {
        latestSeek.resolves.splice(0).forEach((resolve) => resolve())
        latestSeek = null
      }
    }
  })
  presentationDisposer = media.subscribePresentation((event) => {
    if (!isActive()) return
    setSession((draft) => {
      draft.player = mergeArtworkCompletion(draft.player, event)
    })
  })
  void refreshAll()

  return {
    session,
    subscribe(listener) {
      sessionListeners.add(listener)
      listener(session)
      return () => sessionListeners.delete(listener)
    },
    refreshAll,
    async openApp() {
      if (!isActive()) return
      try {
        openNowPlayingApp()
        context.ui.toast.show({
          title: "Music",
          message: "Play in any app — the sidebar uses system media",
          variant: "info",
        })
      } catch (error) {
        setTransportError(errMsg(error))
      }
    },
    playPause,
    seek,
    next: () => runCommand(() => media.next()),
    prev: () => runCommand(() => media.previous()),
    dispose() {
      if (disposed) return
      disposed = true
      lifecycleGeneration++
      eventDisposer?.()
      eventDisposer = null
      presentationDisposer?.()
      presentationDisposer = null
      latestSeek?.resolves.splice(0).forEach((resolve) => resolve())
      latestSeek = null
      activeSeek?.resolves.splice(0).forEach((resolve) => resolve())
      activeSeek = null
      for (const resolve of [...pending]) settle(resolve)
      void media.dispose().catch(() => {})
      setLoadingOwner(false)
      sessionListeners.clear()
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
  /** Test-only factory override; production always uses the session adapter. */
  createSessionMedia?: () => SessionMedia
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
      }
      const ctrl =
        options?.createController?.(context) ??
        createController(
          context,
          options?.createSessionMedia
            ? {
                ...controllerDependencies,
                createSessionMedia: options.createSessionMedia,
              }
            : controllerDependencies,
        )
      // Slot renderers must observe host-owned state before package components run.
      const observeSession = () => {
        void ctrl.session.loading
        void ctrl.session.error
        void ctrl.session.player
      }
      const unsubApp = context.ui.slot({
        append: "session.composer.top",
        render: () => {
          observeSession()
          return <AppHost context={context} ctrl={ctrl} />
        },
      })
      const unsubSidebar = context.ui.slot({
        append: "sidebar.content",
        render: () => {
          observeSession()
          return (
            <SidebarPlayer
              context={context}
              state={ctrl.session}
              subscribe={ctrl.subscribe}
              onPlayPause={() => void ctrl.playPause()}
              onNext={() => void ctrl.next()}
              onPrev={() => void ctrl.prev()}
              onSeek={(positionMs) => void ctrl.seek(positionMs)}
            />
          )
        },
      })
      return () => {
        unsubApp()
        unsubSidebar()
        ctrl.dispose()
      }
    },
  })
}

export default createMusicPlayerPlugin()
