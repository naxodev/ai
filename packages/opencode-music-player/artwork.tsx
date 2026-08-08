/** @jsxImportSource @opentui/solid */
import type { BoxRenderable } from "@opentui/core"
import { For, onCleanup, onMount } from "solid-js"
import type { Plugin } from "@opencode-ai/plugin/tui"
import type { Artwork } from "./types.ts"
import {
  kittyDelete,
  kittyDeletePlacement,
  kittyDisplayPng,
  kittyImageId,
  kittyPlace,
  writeGraphics,
} from "./kitty-graphics.ts"

type Context = Plugin.Context
let cachedTmuxOffset = { x: 0, y: 0, checked_at: 0 }

function terminalOffset(): { x: number; y: number } {
  if (!process.env.TMUX || process.env.HERDR_ENV) return { x: 0, y: 0 }
  const now = Date.now()
  if (now - cachedTmuxOffset.checked_at < 1_000) return cachedTmuxOffset
  const result = Bun.spawnSync([
    "tmux",
    "display-message",
    "-p",
    "#{pane_left}\t#{pane_top}\t#{status-position}\t#{status}",
  ])
  if (result.exitCode !== 0) {
    cachedTmuxOffset = { x: 0, y: 0, checked_at: now }
    return cachedTmuxOffset
  }
  const [left, top, statusPosition, status] = result.stdout
    .toString()
    .trim()
    .split("\t")
  cachedTmuxOffset = {
    x: Number.parseInt(left ?? "0", 10) || 0,
    y:
      (Number.parseInt(top ?? "0", 10) || 0) +
      (statusPosition === "top" && status !== "off" ? 1 : 0),
    checked_at: now,
  }
  return cachedTmuxOffset
}

function supportsKittyGraphics(context: Context): boolean {
  return (
    !!context.renderer.capabilities?.kitty_graphics ||
    process.env.TERM_PROGRAM?.toLowerCase() === "ghostty"
  )
}

export function AlbumArtwork(props: { context: Context; artwork: Artwork }) {
  let container: BoxRenderable | undefined
  let transmitted = 0
  let placement = ""
  let paintPending = false
  let disposed = false

  const removeImage = () => {
    if (!transmitted) return
    writeGraphics(props.context.renderer, kittyDelete(transmitted))
    transmitted = 0
    placement = ""
  }

  const paintNativeImage = () => {
    if (
      !container ||
      container.isDestroyed ||
      container.width < 1 ||
      container.height < 1 ||
      !supportsKittyGraphics(props.context)
    ) {
      removeImage()
      return
    }

    const imageId = kittyImageId(props.artwork.id)
    const offset = terminalOffset()
    const screenX = container.screenX + offset.x
    const screenY = container.screenY + offset.y
    const nextPlacement = [
      imageId,
      screenX,
      screenY,
      container.width,
      container.height,
    ].join(":")
    if (transmitted !== imageId) {
      removeImage()
      const commands = kittyDisplayPng(
        props.artwork.png_base64,
        imageId,
        screenX,
        screenY,
        container.width,
        container.height,
      )
      if (
        !commands.every((command) =>
          writeGraphics(props.context.renderer, command),
        )
      ) {
        return
      }
      transmitted = imageId
      placement = nextPlacement
      return
    }

    if (placement === nextPlacement) return
    if (placement) {
      writeGraphics(props.context.renderer, kittyDeletePlacement(imageId))
    }
    writeGraphics(
      props.context.renderer,
      kittyPlace(
        imageId,
        imageId,
        screenX,
        screenY,
        container.width,
        container.height,
      ),
    )
    placement = nextPlacement
  }

  const scheduleNativeImage = () => {
    if (paintPending || disposed) return
    paintPending = true
    void props.context.renderer.idle().then(() => {
      paintPending = false
      if (!disposed) paintNativeImage()
    })
  }

  onMount(() => props.context.renderer.on("frame", scheduleNativeImage))
  onCleanup(() => {
    disposed = true
    props.context.renderer.off("frame", scheduleNativeImage)
    void props.context.renderer.idle().then(removeImage)
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
