import type { CliRenderer } from "@opentui/core"

const APC = "\x1b_G"
const ST = "\x1b\\"
const CHUNK_SIZE = 4096

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
        `\x1b7\x1b[${y + 1};${x + 1}H${APC}a=T,f=100,i=${imageId},p=${imageId},q=2,C=1,c=${width},r=${height},z=1,`,
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
  return `\x1b7\x1b[${y + 1};${x + 1}H${APC}a=p,i=${imageId},p=${placementId},q=2,c=${width},r=${height},z=1;${ST}\x1b8`
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

type RendererWriter = {
  stdout?: NodeJS.WriteStream
  realStdoutWrite?: NodeJS.WriteStream["write"]
}

/** OpenTUI detects Kitty graphics but does not yet expose a raw output API. */
export function writeGraphics(
  renderer: CliRenderer,
  data: string | readonly string[],
): boolean {
  const target = renderer as unknown as RendererWriter
  if (!target.stdout || typeof target.realStdoutWrite !== "function")
    return false
  const output = (value: string) =>
    process.env.TMUX && !process.env.HERDR_ENV ? tmuxPassthrough(value) : value
  let cursorSaved = false
  try {
    for (const command of typeof data === "string" ? [data] : data) {
      if (command.includes("\x1b7")) cursorSaved = true
      target.realStdoutWrite.call(target.stdout, output(command))
      if (command.includes("\x1b8")) cursorSaved = false
    }
    return true
  } catch {
    if (cursorSaved) {
      try {
        target.realStdoutWrite.call(target.stdout, output("\x1b8"))
      } catch {
        // The original transaction still failed; restoration is best effort.
      }
    }
    return false
  }
}
