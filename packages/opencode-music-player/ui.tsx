/** @jsxImportSource @opentui/solid */
import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import type { Plugin } from "@opencode-ai/plugin/tui"
import {
  MouseButton,
  type BoxRenderable,
  type TextNodeRenderable,
  type TextRenderable,
} from "@opentui/core"
import { formatMs } from "./types.ts"
import { AlbumArtwork } from "./artwork.tsx"
import { Waveform, type PlayerPresentationSource } from "./waveform.tsx"

export type UiState = {
  loading: boolean
  error: string | null
  player: import("./types.ts").PlayerState | null
}

type Theme = Context["theme"]
type Context = Plugin.Context
type UiStateSubscribe = (listener: (state: UiState) => void) => () => void

/** Text presentation keeps media symbols single-cell on emoji fonts. */
const t = (s: string) => s + "\uFE0E"
const Icon = {
  prev: t("⏮"),
  next: t("⏭"),
  play: t("▶"),
  pause: t("⏸"),
  scrub: "●",
} as const

/** Matches artwork / waveform / progress content width. */
export const TRANSPORT_CONTENT_WIDTH = 24

/** Pre-change baseline — documented for tests; do not use as live sizes. */
export const TRANSPORT_BASELINE = {
  prevWidth: 5,
  playWidth: 7,
  nextWidth: 5,
  height: 1,
  gap: 1,
} as const

export const TRANSPORT_LAYOUT = {
  prevWidth: 6,
  playWidth: 10,
  nextWidth: 6,
  /** Shared enlarged hit height for all three controls. */
  height: 2,
  gap: 1,
} as const

export function transportRowWidth(
  layout: {
    prevWidth: number
    playWidth: number
    nextWidth: number
    gap: number
  } = TRANSPORT_LAYOUT,
): number {
  return (
    layout.prevWidth +
    layout.gap +
    layout.playWidth +
    layout.gap +
    layout.nextWidth
  )
}

export const COMPACT_MARKER_WIDTH = 1
export const COMPACT_TITLE_SEPARATOR = " "
export const COMPACT_SEPARATOR = " - "
export const COMPACT_SEEK_FRACTION = 0.8

export function compactSeekRegionWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0
  const available = Math.floor(width)
  return Math.max(
    0,
    Math.min(available, Math.round(available * COMPACT_SEEK_FRACTION)),
  )
}

export function seekPositionForCell(
  cell: number,
  width: number,
  durationMs: number,
): number | null {
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return null
  }
  const lastCell = Math.max(0, Math.floor(width) - 1)
  const clampedCell = Math.max(0, Math.min(lastCell, Math.floor(cell)))
  const ratio = lastCell === 0 ? 0 : clampedCell / lastCell
  return Math.round(ratio * durationMs)
}

export const COMPACT_BUDGETS = {
  wide: {
    minWidth: 55,
    padding: 1,
    titleWidth: 28,
    artistWidth: 20,
  },
  medium: {
    minWidth: 32,
    padding: 1,
    titleWidth: 28,
    artistWidth: 0,
  },
  narrow: {
    minWidth: 6,
    padding: 1,
    titleWidth: 2,
    artistWidth: 0,
  },
  markerOnly: {
    minWidth: 1,
    padding: 0,
    titleWidth: 0,
    artistWidth: 0,
  },
} as const

export type CompactTier = keyof typeof COMPACT_BUDGETS

export type CompactPresentation = {
  tier: CompactTier
  marker: string
  padding: number
  title: string | null
  artist: string | null
}

function sanitize(value: string, fallback = ""): string {
  const clean = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return clean || fallback
}

function truncate(value: string, width: number): string {
  if (Bun.stringWidth(value) <= width) return value
  if (width <= 1) return "…"

  let result = ""
  for (const character of value) {
    if (Bun.stringWidth(result + character) > width - 1) break
    result += character
  }
  return `${result}…`
}

/** Allocate the compact row from its actual parent width, not renderer width. */
export function compactPresentation(
  width: number,
  title: string,
  artist: string,
  playing: boolean,
): CompactPresentation {
  const available = Math.max(1, Math.floor(width))
  const marker = playing ? Icon.pause : Icon.play
  const cleanTitle = sanitize(title, "Unknown track")
  const cleanArtist = sanitize(artist)

  const tier: CompactTier =
    available >= COMPACT_BUDGETS.wide.minWidth
      ? "wide"
      : available >= COMPACT_BUDGETS.medium.minWidth
        ? "medium"
        : available >= COMPACT_BUDGETS.narrow.minWidth
          ? "narrow"
          : "markerOnly"
  const budget = COMPACT_BUDGETS[tier]
  if (tier === "markerOnly") {
    return { tier, marker, padding: budget.padding, title: null, artist: null }
  }

  const fixedWidth =
    COMPACT_MARKER_WIDTH + COMPACT_TITLE_SEPARATOR.length + budget.padding * 2
  const titleWidth =
    tier === "narrow" ? available - fixedWidth : budget.titleWidth
  return {
    tier,
    marker,
    padding: budget.padding,
    title: truncate(cleanTitle, titleWidth),
    artist:
      tier === "wide" && cleanArtist
        ? truncate(cleanArtist, budget.artistWidth)
        : null,
  }
}

export function CompactPlayer(props: {
  context: Context
  state: UiState
  onPlayPause: () => void
  onSeek: (positionMs: number) => void
}) {
  const theme = () => props.context.theme
  let row: BoxRenderable | undefined
  let content: TextRenderable | undefined
  let allocatedWidth = Number.MAX_SAFE_INTEGER
  const track = createMemo(() => props.state.player?.track)
  const renderLine = () => {
    const current = track()
    if (!current) return ""
    const display = compactPresentation(
      allocatedWidth,
      current.name,
      current.artists,
      !!props.state.player?.is_playing,
    )
    const padding = " ".repeat(display.padding)
    return `${padding}${display.marker}${
      display.title ? `${COMPACT_TITLE_SEPARATOR}${display.title}` : ""
    }${display.artist ? `${COMPACT_SEPARATOR}${display.artist}` : ""}${padding}`
  }
  const updateContent = () => {
    const line = renderLine()
    if (content) content.content = line
  }
  const updateWidth = function (this: BoxRenderable) {
    allocatedWidth = Math.max(1, this.width)
    updateContent()
  }
  createEffect(updateContent)
  onCleanup(() => {
    if (row?.onSizeChange === updateWidth) row.onSizeChange = undefined
  })

  return (
    <Show when={track()}>
      {(_track) => (
        <box
          id="music-compact-player"
          ref={(element) => {
            row = element
            element.onSizeChange = updateWidth
          }}
          width="100%"
          alignSelf="stretch"
          minWidth={0}
          height={1}
          flexDirection="row"
          flexShrink={0}
          overflow="hidden"
          onMouseDown={(event) => {
            if (event.button !== MouseButton.LEFT) return
            const current = props.state.player?.track
            if (!current || !row) return

            const seekWidth = compactSeekRegionWidth(row.width)
            const cell = Math.floor(event.x - row.x)
            const markerCell = compactPresentation(
              row.width,
              current.name,
              current.artists,
              !!props.state.player?.is_playing,
            ).padding
            if (cell === markerCell) {
              event.preventDefault()
              event.stopPropagation()
              props.onPlayPause()
              return
            }
            if (cell < 0 || cell >= seekWidth) return

            const position = seekPositionForCell(
              cell,
              seekWidth,
              current.duration_ms,
            )
            if (position === null) return

            event.preventDefault()
            event.stopPropagation()
            props.onSeek(position)
          }}
        >
          <text
            ref={(element) => {
              content = element
              updateContent()
            }}
            wrapMode="none"
            truncate
            fg={theme().text.action.primary.default}
          >
            {renderLine()}
          </text>
        </box>
      )}
    </Show>
  )
}

function liveProgress(player: UiState["player"], now = Date.now()): number {
  if (!player?.track) return 0
  if (!player.is_playing) return player.progress_ms
  return Math.min(
    player.track.duration_ms,
    player.progress_ms + (Math.max(now, player.fetched_at) - player.fetched_at),
  )
}

function progressSegments(progress: number, duration: number, width: number) {
  if (duration <= 0) return { left: "", thumb: "", right: "─".repeat(width) }
  const ratio = Math.max(0, Math.min(1, progress / duration))
  const track = width - 1
  const filled = Math.max(0, Math.min(track, Math.round(ratio * track)))
  return {
    left: "━".repeat(filled),
    thumb: Icon.scrub,
    right: "─".repeat(Math.max(0, track - filled)),
  }
}

function ProgressBar(props: {
  theme: Theme
  source: PlayerPresentationSource
  width?: number
  accent?: string | undefined
  onSeek: (positionMs: number) => void
}) {
  let bar: BoxRenderable | undefined
  let leftNode: TextNodeRenderable | undefined
  let thumbNode: TextNodeRenderable | undefined
  let rightNode: TextNodeRenderable | undefined
  const width = () => Math.max(8, props.width ?? 28)
  const rendered = () => {
    const player = props.source.current()
    return progressSegments(
      liveProgress(player),
      player?.track?.duration_ms ?? 0,
      width(),
    )
  }
  const paint = () => {
    const next = rendered()
    if (leftNode) leftNode.children = [next.left]
    if (thumbNode) thumbNode.children = [next.thumb]
    if (rightNode) rightNode.children = [next.right]
  }

  onMount(() => {
    const unsubscribe = props.source.subscribe(() => paint())
    const timer = setInterval(() => {
      if (props.source.current()?.is_playing) paint()
    }, 1_000)
    onCleanup(() => {
      unsubscribe()
      clearInterval(timer)
    })
  })

  return (
    <box
      id="music-sidebar-seek"
      ref={(element) => (bar = element)}
      width={width()}
      height={1}
      onMouseDown={(event) => {
        if (event.button !== MouseButton.LEFT || !bar) return
        const position = seekPositionForCell(
          event.x - bar.x,
          bar.width,
          props.source.current()?.track?.duration_ms ?? 0,
        )
        if (position === null) return
        event.preventDefault()
        event.stopPropagation()
        props.onSeek(position)
      }}
    >
      <text>
        <span
          ref={(element) => (leftNode = element)}
          style={{
            fg: props.accent ?? props.theme.text.action.primary.default,
          }}
        >
          {rendered().left}
        </span>
        <span
          ref={(element) => (thumbNode = element)}
          style={{
            fg: props.accent ?? props.theme.text.action.primary.default,
          }}
        >
          {rendered().thumb}
        </span>
        <span
          ref={(element) => (rightNode = element)}
          style={{ fg: props.theme.text.subdued }}
        >
          {rendered().right}
        </span>
      </text>
    </box>
  )
}

function LiveElapsed(props: {
  theme: Theme
  source: PlayerPresentationSource
}) {
  let text: TextRenderable | undefined
  const paint = () => {
    if (text) text.content = formatMs(liveProgress(props.source.current()))
  }
  onMount(() => {
    const unsubscribe = props.source.subscribe(() => paint())
    const timer = setInterval(() => {
      if (props.source.current()?.is_playing) paint()
    }, 1_000)
    onCleanup(() => {
      unsubscribe()
      clearInterval(timer)
    })
  })
  return (
    <text ref={(element) => (text = element)} fg={props.theme.text.subdued}>
      {formatMs(liveProgress(props.source.current()))}
    </text>
  )
}

/** Hover/press icon button — props read in JSX (Solid setup is once). */
function IconBtn(props: {
  theme: Theme
  icon: string
  /** Accessible / tooltip-ish label shown nowhere — reserved */
  title?: string
  /** Emphasized play control */
  primary?: boolean
  /** Currently “on” (playing) */
  active?: boolean
  accent?: string | undefined
  /** Fixed outer width in cells */
  width?: number
  /** Fixed outer height in cells */
  height?: number
  onClick: () => void
}) {
  const [hover, setHover] = createSignal(false)
  const [press, setPress] = createSignal(false)

  const bg = () => {
    if (press() || props.active) {
      return props.theme.background.action.primary.default
    }
    // Idle + hover share offset so the cluster reads as one control strip
    return props.theme.background.surface.offset
  }

  const fg = () => {
    if (press() || props.active)
      return props.accent ?? props.theme.text.action.primary.default
    if (props.primary) {
      return hover()
        ? props.theme.text.action.primary.default
        : props.theme.text.default
    }
    return hover()
      ? props.theme.text.action.primary.default
      : props.theme.text.default
  }

  const w = () => props.width ?? 3
  const h = () => props.height ?? 1

  return (
    <box
      onMouseDown={() => {
        setPress(true)
        props.onClick()
      }}
      onMouseUp={() => setPress(false)}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => {
        setHover(false)
        setPress(false)
      }}
      flexShrink={0}
      width={w()}
      height={h()}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bg()}
    >
      <text fg={fg()}>{props.icon}</text>
    </box>
  )
}

export function SidebarPlayer(props: {
  context: Context
  state: UiState
  subscribe?: UiStateSubscribe
  onPlayPause: () => void
  onNext: () => void
  onPrev: () => void
  onSeek: (positionMs: number) => void
}) {
  const theme = () => props.context.theme
  let latestPlayer = props.state.player
  const presentationListeners = new Set<(player: UiState["player"]) => void>()
  const publishPlayer = (player: UiState["player"]) => {
    latestPlayer = player
    for (const listener of [...presentationListeners]) {
      try {
        listener(player)
      } catch {
        // One presentation widget cannot block its siblings.
      }
    }
  }
  const source: PlayerPresentationSource = {
    current: () => latestPlayer,
    subscribe(listener) {
      presentationListeners.add(listener)
      try {
        listener(latestPlayer)
      } catch {
        // Initial presentation failure remains isolated to this widget.
      }
      return () => presentationListeners.delete(listener)
    },
  }
  createEffect(() => publishPlayer(props.state.player))
  const unsubscribeSession = props.subscribe?.((state) =>
    publishPlayer(state.player),
  )
  onCleanup(() => {
    unsubscribeSession?.()
    presentationListeners.clear()
  })
  const player = createMemo(() => props.state.player)
  const track = createMemo(() => player()?.track)
  const playing = createMemo(() => !!player()?.is_playing)

  const duration = createMemo(() => track()?.duration_ms ?? 0)

  return (
    <box
      flexDirection="column"
      border={["top"]}
      borderColor={
        playing()
          ? (track()?.artwork?.accent ?? theme().text.action.primary.default)
          : theme().border.default
      }
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
      flexShrink={0}
    >
      <Show when={props.state.error}>
        {(err) => <text fg={theme().text.feedback.error.default}>{err()}</text>}
      </Show>

      <box flexDirection="row" justifyContent="center">
        <box width={24} height={12} overflow="hidden">
          <Show
            when={track()?.artwork}
            fallback={
              <box
                width={24}
                height={12}
                alignItems="center"
                justifyContent="center"
              >
                <text fg={theme().text.subdued}>
                  {track()
                    ? track()?.artwork_loading
                      ? "Loading artwork…"
                      : "Artwork unavailable"
                    : ""}
                </text>
              </box>
            }
          >
            {(artwork) => (
              <AlbumArtwork context={props.context} artwork={artwork()} />
            )}
          </Show>
        </box>
      </box>

      <Show
        when={track()}
        fallback={
          <text fg={theme().text.subdued}>
            {props.state.loading ? "Syncing…" : "Nothing playing"}
          </text>
        }
      >
        {(t) => (
          <box flexDirection="column" gap={0}>
            <text fg={theme().text.default}>
              <b>{t().name}</b>
            </text>
            <Show when={t().artists}>
              <text fg={theme().text.subdued}>{t().artists}</text>
            </Show>
            <Show when={t().album}>
              <text fg={theme().text.subdued}>{t().album}</text>
            </Show>
          </box>
        )}
      </Show>

      <box flexDirection="row" justifyContent="center" overflow="hidden">
        <Waveform theme={theme()} source={source} bars={24} variant="hero" />
      </box>

      <Show when={track() && duration() > 0}>
        <box flexDirection="column" gap={0} overflow="hidden">
          <ProgressBar
            theme={theme()}
            source={source}
            width={24}
            accent={track()?.artwork?.accent}
            onSeek={props.onSeek}
          />
          <box flexDirection="row" justifyContent="space-between">
            <LiveElapsed theme={theme()} source={source} />
            <text fg={theme().text.subdued}>{formatMs(duration())}</text>
          </box>
        </box>
      </Show>

      <box
        flexDirection="row"
        gap={TRANSPORT_LAYOUT.gap}
        justifyContent="center"
      >
        <IconBtn
          theme={theme()}
          icon={Icon.prev}
          width={TRANSPORT_LAYOUT.prevWidth}
          height={TRANSPORT_LAYOUT.height}
          onClick={() => props.onPrev()}
        />
        <IconBtn
          theme={theme()}
          icon={playing() ? Icon.pause : Icon.play}
          primary
          active={playing()}
          accent={track()?.artwork?.accent}
          width={TRANSPORT_LAYOUT.playWidth}
          height={TRANSPORT_LAYOUT.height}
          onClick={() => props.onPlayPause()}
        />
        <IconBtn
          theme={theme()}
          icon={Icon.next}
          width={TRANSPORT_LAYOUT.nextWidth}
          height={TRANSPORT_LAYOUT.height}
          onClick={() => props.onNext()}
        />
      </box>
    </box>
  )
}
