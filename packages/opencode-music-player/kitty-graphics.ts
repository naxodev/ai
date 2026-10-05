import type { CliRenderer } from "@opentui/core"

const APC = "\x1b_G"
const ST = "\x1b\\"
const CHUNK_SIZE = 4096

function scalingDimensions(width: number, height: number): string {
  return [width > 0 ? `c=${width}` : "", height > 0 ? `r=${height}` : ""]
    .filter(Boolean)
    .join(",")
}

export function tmuxPassthrough(data: string): string {
  return `\x1bPtmux;${data.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
}

export function kittyTransmitPng(pngBase64: string, imageId: number): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < pngBase64.length; offset += CHUNK_SIZE) {
    const chunk = pngBase64.slice(offset, offset + CHUNK_SIZE)
    const more = offset + CHUNK_SIZE < pngBase64.length ? 1 : 0
    const control =
      offset === 0 ? `a=t,f=100,i=${imageId},q=2,m=${more}` : `m=${more}`
    chunks.push(`${APC}${control};${chunk}${ST}`)
  }
  return chunks
}

export function kittyDisplayPng(
  pngBase64: string,
  imageId: number,
  x: number,
  y: number,
  width: number,
  height: number,
): string[] {
  const chunks = kittyTransmitPng(pngBase64, imageId)
  return chunks.map((command, index) => {
    let next = command
    if (index === 0) {
      next = next.replace(
        `${APC}a=t,f=100,i=${imageId},q=2,`,
        `\x1b7\x1b[${y + 1};${x + 1}H${APC}a=T,f=100,i=${imageId},p=${imageId},q=2,C=1,${scalingDimensions(width, height)},z=1,`,
      )
    }
    return index === chunks.length - 1 ? `${next}\x1b8` : next
  })
}

export function kittyPlace(
  imageId: number,
  placementId: number,
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  return `\x1b7\x1b[${y + 1};${x + 1}H${APC}a=p,i=${imageId},p=${placementId},q=2,${scalingDimensions(width, height)},z=1;${ST}\x1b8`
}

export function kittyDelete(imageId: number): string {
  return `${APC}a=d,d=I,i=${imageId},q=2;${ST}`
}

export function kittyDeletePlacement(imageId: number): string {
  return `${APC}a=d,d=i,i=${imageId},q=2;${ST}`
}

export function kittyImageId(key: string): number {
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0 || 1
}

type SerializedRendererWriter = {
  writeOut?: (chunk: string) => unknown
}

/**
 * OpenTUI 0.5.12 keeps writeOut private, but OpenCode 2.0.18 uses it to queue
 * one complete output transaction with its native renderer thread. Do not use
 * raw stdout here: it can interleave cursor frames with a Kitty transfer.
 */
export function writeGraphics(
  renderer: CliRenderer,
  data: string | readonly string[],
): boolean {
  // SAFETY: OpenCode 2.0.18's pinned renderer has private writeOut; the runtime guard verifies it is callable.
  const target = renderer as unknown as SerializedRendererWriter
  if (typeof target.writeOut !== "function") return false
  const commands = typeof data === "string" ? [data] : data
  const output = (value: string) =>
    process.env.TMUX && !process.env.HERDR_ENV ? tmuxPassthrough(value) : value

  try {
    // Preserve per-command tmux wrappers, but queue the full Kitty transaction.
    // This includes its saved/restored cursor and cannot race a native frame.
    target.writeOut.call(renderer, commands.map(output).join(""))
    // OpenTUI's direct-stream fallback can return false for backpressure after
    // accepting data. A non-throwing host hook has accepted this transaction.
    return true
  } catch {
    return false
  }
}
