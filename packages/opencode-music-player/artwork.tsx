/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, CliRenderer } from "@opentui/core"
import { For, onCleanup, onMount } from "solid-js"
import type { Plugin } from "@opencode-ai/plugin/tui"
import type { Artwork } from "./types.ts"
import {
  planNativeArtworkPlacement,
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

  const paintNativeImage = () => {
    if (!ownership.isCurrent()) return
    if (runtime.identity !== props.artwork.id) {
      runtime.identity = props.artwork.id
      writeGraphics(
        props.context.renderer,
        kittyDelete(legacyImageIdForResolvedArtwork(props.artwork)),
      )
      runtime.state = { transmitted: 0, placement: null }
    }
    const kittySupported = supportsKittyGraphics(props.context)
    const slotValid =
      !!container &&
      !container.isDestroyed &&
      container.width >= 1 &&
      container.height >= 1

    const slot: SlotGeometry | null = container
      ? {
          screenX: container.screenX,
          screenY: container.screenY,
          width: container.width,
          height: container.height,
        }
      : null
    const offset = terminalOffset(slot)
    const imageId = imageIdForArtwork(props.artwork.id)
    const x = slot ? slot.screenX + offset.x : 0
    const y = slot ? slot.screenY + offset.y : 0
    const width = slot?.width ?? 0
    const height = slot?.height ?? 0

    const plan = planNativeArtworkPlacement({
      state: runtime.state,
      imageId,
      x,
      y,
      width,
      height,
      kittySupported,
      slotValid,
      disposed,
    })

    if (plan.actions.length === 0) return
    if (applyPlan(plan)) commitPlan(plan)
  }

  const scheduleNativeImage = () => {
    if (paintPending || disposed) return
    paintPending = true
    void props.context.renderer.idle().then(() => {
      paintPending = false
      if (!disposed && ownership.isCurrent()) paintNativeImage()
    })
  }

  onMount(() => props.context.renderer.on("frame", scheduleNativeImage))
  onCleanup(() => {
    disposed = true
    props.context.renderer.off("frame", scheduleNativeImage)
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
      width={24}
      height={12}
      flexDirection="column"
      overflow="hidden"
    >
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
    </box>
  )
}
