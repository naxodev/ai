/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, CliRenderer } from "@opentui/core"
import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { Artwork } from "./types.ts"
import { pngDimensions } from "./artwork.ts"
import {
  planNativeArtworkPlacement,
  fitNativeArtworkGeometry,
  type NativeArtworkPlacementAction,
  type NativeArtworkPlacementPlan,
  type NativeArtworkState,
} from "./artwork-placement.ts"
import {
  kittyDelete,
  kittyDeletePlacement,
  kittyDisplayPng,
  kittyImageId,
  kittyPlace,
  writeGraphics,
} from "./kitty-graphics.ts"
import {
  createTmuxOffsetCache,
  resolveTerminalOffset,
  type SlotGeometry,
} from "./tmux-offset.ts"

type Context = Plugin.Context
const tmuxOffsetCache = createTmuxOffsetCache()
const nativeArtworkImageId = kittyImageId("opencode-music-player:artwork")
type NativeArtworkRuntime = {
  latestOwner: number
  state: NativeArtworkState
  identity: string
}
const defaultOwnershipScope = { latestOwner: 0 }
const nativeArtworkRuntimes = new WeakMap<CliRenderer, NativeArtworkRuntime>()

function nativeArtworkRuntime(renderer: CliRenderer): NativeArtworkRuntime {
  const existing = nativeArtworkRuntimes.get(renderer)
  if (existing) return existing
  const created = {
    latestOwner: 0,
    state: { transmitted: 0, placement: null },
    identity: "",
  }
  nativeArtworkRuntimes.set(renderer, created)
  return created
}

export type NativeArtworkOwnership = { isCurrent: () => boolean }

export function claimNativeArtworkOwnership(
  scope: { latestOwner: number } = defaultOwnershipScope,
): NativeArtworkOwnership {
  const owner = ++scope.latestOwner
  return { isCurrent: () => owner === scope.latestOwner }
}

export function cleanupNativeArtwork(
  ownership: NativeArtworkOwnership,
  remove: () => void,
): void {
  if (ownership.isCurrent()) remove()
}

export function imageIdForArtwork(_artworkId: string): number {
  return nativeArtworkImageId
}

export function legacyImageIdForArtwork(artworkId: string): number {
  return kittyImageId(artworkId)
}

export function legacyImageIdForResolvedArtwork(
  artwork: Pick<Artwork, "id" | "legacy_id">,
): number {
  return legacyImageIdForArtwork(artwork.legacy_id ?? artwork.id)
}

function terminalOffset(slot: SlotGeometry | null) {
  return resolveTerminalOffset({
    slot,
    cache: tmuxOffsetCache,
  })
}

function supportsKittyGraphics(context: Context): boolean {
  return (
    !!context.renderer.capabilities?.kitty_graphics ||
    process.env.TERM_PROGRAM?.toLowerCase() === "ghostty"
  )
}

function copyState(next: NativeArtworkState): NativeArtworkState {
  return {
    transmitted: next.transmitted,
    placement: next.placement ? { ...next.placement } : null,
  }
}

export function AlbumArtwork(props: { context: Context; artwork: Artwork }) {
  const renderer = props.context.renderer
  const runtime = nativeArtworkRuntime(renderer)
  const ownership = claimNativeArtworkOwnership(runtime)
  let container: BoxRenderable | undefined
  let paintPending = false
  let disposed = false
  let renderedFrameId = -1
  let renderedSlot: SlotGeometry | null = null
  let placementInvalidated = false
  let awaitingResizeGeometry = false
  const [nativeVisible, setNativeVisible] = createSignal(false)
  const imageDimensions = createMemo(() =>
    pngDimensions(props.artwork.png_base64),
  )

  const applyAction = (action: NativeArtworkPlacementAction): boolean => {
    const renderer = props.context.renderer
    switch (action.type) {
      case "delete-image":
        return writeGraphics(renderer, kittyDelete(action.imageId))
      case "delete-placement":
        return writeGraphics(renderer, kittyDeletePlacement(action.imageId))
      case "transmit-and-display": {
        const commands = kittyDisplayPng(
          props.artwork.png_base64,
          action.imageId,
          action.x,
          action.y,
          action.width,
          action.height,
        )
        return writeGraphics(renderer, commands)
      }
      case "place":
        return writeGraphics(
          renderer,
          kittyPlace(
            action.imageId,
            action.placementId,
            action.x,
            action.y,
            action.width,
            action.height,
          ),
        )
    }
  }

  // Partial success must not commit: stop on first failed write and keep prior state.
  const applyPlan = (plan: NativeArtworkPlacementPlan): boolean => {
    for (const action of plan.actions) {
      if (!applyAction(action)) return false
    }
    return true
  }

  const commitPlan = (plan: NativeArtworkPlacementPlan) => {
    runtime.state = copyState(plan.nextState)
  }

  const clearInvalidatedPlacement = (): boolean => {
    if (!placementInvalidated) return true
    if (
      runtime.state.transmitted !== 0 &&
      !writeGraphics(renderer, kittyDeletePlacement(runtime.state.transmitted))
    )
      return false
    runtime.state = { ...runtime.state, placement: null }
    placementInvalidated = false
    return true
  }

  /**
   * Drop the placement but keep the transmitted PNG, so the image can return
   * cheaply when the sidebar has room again. Used when the slot stops rendering
   * or no longer fits, where a lingering absolute placement would escape layout.
   */
  const clearPlacement = (): boolean => {
    if (
      runtime.state.transmitted !== 0 &&
      runtime.state.placement !== null &&
      !writeGraphics(renderer, kittyDeletePlacement(runtime.state.transmitted))
    )
      return false
    runtime.state = { ...runtime.state, placement: null }
    renderedSlot = null
    setNativeVisible(false)
    return true
  }

  /**
   * The fixed-size artwork box must fit inside every ancestor, and fully inside
   * each clipping ancestor's visible rect. Sidebar content that overflows its
   * viewport otherwise leaves the absolute image drawn over the transcript.
   */
  const fitsAvailableSpace = (node: BoxRenderable): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.width < node.width || parent.height < node.height) return false
      if (parent.overflow === "visible") continue
      if (
        node.screenX < parent.screenX ||
        node.screenY < parent.screenY ||
        node.screenX + node.width > parent.screenX + parent.width ||
        node.screenY + node.height > parent.screenY + parent.height
      )
        return false
    }
    return true
  }

  /** The slot must also fit inside the renderer's visible terminal viewport. */
  const fitsViewport = (slot: SlotGeometry): boolean =>
    slot.screenX >= 0 &&
    slot.screenY >= 0 &&
    slot.screenX + slot.width <= renderer.terminalWidth &&
    slot.screenY + slot.height <= renderer.terminalHeight

  const invalidateForResize = () => {
    if (disposed || !ownership.isCurrent()) return
    // A pane can move in tmux without changing the artwork's local geometry.
    tmuxOffsetCache.offset = null
    tmuxOffsetCache.slot = null
    // Terminal reflow can move an image even when its Yoga geometry is unchanged.
    // Remove it before waiting for fresh layout and terminal pixel metrics.
    renderedFrameId = -1
    renderedSlot = null
    placementInvalidated = true
    awaitingResizeGeometry = true
    clearInvalidatedPlacement()
    setNativeVisible(false)
  }

  const paintNativeImage = () => {
    if (!ownership.isCurrent()) return
    if (!clearInvalidatedPlacement()) return
    const kittySupported = supportsKittyGraphics(props.context)
    // The artwork box is fixed-size. When an ancestor is smaller, the image has
    // no room and must not be drawn outside the layout.
    if (container && !fitsAvailableSpace(container)) {
      clearPlacement()
      return
    }
    const slotValid =
      !!container &&
      !container.isDestroyed &&
      container.width >= 1 &&
      container.height >= 1

    const slot = renderedSlot
    if (slot && !fitsViewport(slot)) {
      clearPlacement()
      return
    }
    const offset = terminalOffset(slot)
    const imageId = imageIdForArtwork(props.artwork.id)
    const x = slot ? slot.screenX + offset.x : 0
    const y = slot ? slot.screenY + offset.y : 0
    const image = imageDimensions()
    const resolution = renderer.resolution
    const geometry =
      slot && image && resolution
        ? fitNativeArtworkGeometry(
            { x, y, width: slot.width, height: slot.height },
            image,
            {
              width: Math.floor(resolution.width / renderer.terminalWidth),
              height: Math.floor(resolution.height / renderer.terminalHeight),
            },
          )
        : null

    // Resize clears pixel metrics until the terminal answers its new query.
    // Keep the transmitted PNG, but show text until it can be placed safely.
    if (awaitingResizeGeometry && geometry === null && kittySupported) return
    awaitingResizeGeometry = false

    if (runtime.identity !== props.artwork.id) {
      // Delete the previous placement before committing a new cover identity.
      if (!clearPlacement()) return
      if (
        !writeGraphics(
          renderer,
          kittyDelete(legacyImageIdForResolvedArtwork(props.artwork)),
        )
      )
        return
      runtime.identity = props.artwork.id
      runtime.state = { transmitted: 0, placement: null }
    }

    const plan = planNativeArtworkPlacement({
      state: runtime.state,
      imageId,
      ...(geometry ?? { x, y, width: 0, height: 0 }),
      kittySupported,
      slotValid: slotValid && geometry !== null,
      disposed,
    })

    if (plan.actions.length === 0) {
      setNativeVisible(runtime.state.placement !== null)
      return
    }
    if (applyPlan(plan)) {
      commitPlan(plan)
      // Text cells assume a 1:2 font ratio. Do not leave them showing around a
      // native placement fitted to a different measured terminal-cell ratio.
      setNativeVisible(plan.nextState.placement !== null)
    } else setNativeVisible(false)
  }

  const scheduleNativeImage = () => {
    if (paintPending || disposed) return
    paintPending = true
    // A live waveform never becomes idle. Paint after the completed frame,
    // but only if this mount's slot actually rendered in that frame.
    queueMicrotask(() => {
      paintPending = false
      if (disposed || !ownership.isCurrent()) return
      try {
        // A slot that did not render this frame has no room (hidden sidebar or
        // clipped layout). Remove the placement instead of leaving it on screen.
        if (renderedFrameId !== renderer.frameId) clearPlacement()
        else paintNativeImage()
      } catch (error) {
        console.error("Failed to paint music artwork", error)
      }
    })
  }

  onMount(() => {
    renderer.on("frame", scheduleNativeImage)
    renderer.on("resize", invalidateForResize)
  })
  onCleanup(() => {
    disposed = true
    renderer.off("frame", scheduleNativeImage)
    renderer.off("resize", invalidateForResize)
    // A replacement mount claims ownership before the next task runs.
    setTimeout(() => {
      cleanupNativeArtwork(ownership, () => {
        if (!renderer.isDestroyed)
          writeGraphics(renderer, kittyDelete(nativeArtworkImageId))
        runtime.state = { transmitted: 0, placement: null }
        runtime.identity = ""
      })
    }, 0)
  })

  return (
    <box
      ref={(value) => (container = value)}
      renderAfter={() => {
        if (!container) return
        renderedFrameId = renderer.frameId
        renderedSlot = {
          screenX: container.screenX,
          screenY: container.screenY,
          width: container.width,
          height: container.height,
        }
      }}
      width={24}
      height={12}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
    >
      <Show when={!nativeVisible()}>
        <For each={props.artwork.cells}>
          {(row) => (
            <text>
              <For each={row}>
                {(cell) => (
                  <span style={{ fg: cell.upper, bg: cell.lower }}>▀</span>
                )}
              </For>
            </text>
          )}
        </For>
      </Show>
    </box>
  )
}
