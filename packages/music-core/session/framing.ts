/** Shared NDJSON framing. It deliberately has no socket knowledge. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FrameError"
  }
}
export class FrameCountError extends FrameError {}
export class NdjsonFramer {
  #buffer = ""
  // Decoder state must survive data events: a UTF-8 code point may span them.
  #decoder = new TextDecoder()
  #pendingFrameBytes = 0
  readonly maxFrameBytes: number
  constructor(maxFrameBytes = 64 * 1024) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0)
      throw new Error("invalid frame limit")
    this.maxFrameBytes = maxFrameBytes
  }
  push(
    chunk: string | Uint8Array,
    maxFrames = Number.MAX_SAFE_INTEGER,
  ): unknown[] {
    // Scan raw bytes first so an oversized line is rejected before decoding or
    // retaining the chunk. Newline is a single ASCII byte in UTF-8.
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)
    let start = 0
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 0x0a) continue
      if (this.#pendingFrameBytes + index - start > this.maxFrameBytes)
        throw new FrameError("frame exceeds maximum size")
      this.#pendingFrameBytes = 0
      start = index + 1
    }
    if (this.#pendingFrameBytes + bytes.length - start > this.maxFrameBytes)
      throw new FrameError("frame exceeds maximum size")
    this.#pendingFrameBytes += bytes.length - start
    this.#buffer +=
      typeof chunk === "string"
        ? chunk
        : this.#decoder.decode(chunk, { stream: true })
    if (
      Buffer.byteLength(this.#buffer) > this.maxFrameBytes &&
      !this.#buffer.includes("\n")
    )
      throw new FrameError("frame exceeds maximum size")
    if (!Number.isSafeInteger(maxFrames) || maxFrames <= 0)
      throw new Error("invalid decoded frame limit")
    const values: unknown[] = []
    while (true) {
      const newline = this.#buffer.indexOf("\n")
      if (newline < 0) break
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > this.maxFrameBytes)
        throw new FrameError("frame exceeds maximum size")
      if (!line.trim()) throw new FrameError("blank frame")
      if (values.length >= maxFrames)
        throw new FrameCountError("too many frames in one chunk")
      try {
        values.push(JSON.parse(line))
      } catch {
        throw new FrameError("malformed JSON frame")
      }
    }
    if (Buffer.byteLength(this.#buffer) > this.maxFrameBytes)
      throw new FrameError("frame exceeds maximum size")
    return values
  }
  end(): void {
    this.#buffer += this.#decoder.decode()
    if (this.#buffer.trim()) throw new FrameError("incomplete frame at EOF")
    this.#buffer = ""
    this.#pendingFrameBytes = 0
  }
}
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}
