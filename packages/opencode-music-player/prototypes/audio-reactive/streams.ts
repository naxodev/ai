/** Child output is untrusted. Keep bounds in bytes and never retain stderr. */
export const outputLimit = 64 * 1024

export class ReaderCleanupError extends Error {
  constructor() {
    super("Source reader cleanup failed")
  }
}

async function withReader<T>(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  consume: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<T>,
): Promise<T> {
  const reader = stream.getReader()
  let cancellation: Promise<void> | undefined
  let cancellationStarted = false
  const cancel = () => {
    if (cancellationStarted) return
    // Reserve before invoking the source, which can synchronously reenter abort.
    cancellationStarted = true
    try {
      cancellation = reader.cancel()
    } catch {
      cancellation = Promise.reject(new ReaderCleanupError())
      // No cancellation started. Fail pending read requests instead of hanging.
      // Cleanup still rejects; releasing the lock does not claim source shutdown.
      try {
        reader.releaseLock()
      } catch {
        /* The recorded cleanup failure remains fatal. */
      }
    }
    // Observe now, but retain the exact first promise for the cleanup join.
    void cancellation.catch(() => {})
  }
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()
  try {
    return await consume(reader)
  } catch {
    throw new Error("Source output was invalid or could not be read")
  } finally {
    signal?.removeEventListener("abort", cancel)
    cancel()
    try {
      await cancellation
    } catch {
      throw new ReaderCleanupError()
    } finally {
      try {
        reader.releaseLock()
      } catch {
        throw new ReaderCleanupError()
      }
    }
  }
}

export async function drainDiagnostics(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  await withReader(stream, signal, async (reader) => {
    while (!(await reader.read()).done) {
      /* Drop bytes without decoding or copying. */
    }
  })
}

export async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  limit = outputLimit,
): Promise<string> {
  // One fixed allocation; reject an oversized chunk before copying any of it.
  const bytes = new Uint8Array(limit)
  let length = 0
  let overflow = false
  const result = await withReader(stream, signal, async (reader) => {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (next.value.byteLength > limit - length) {
        overflow = true
        break
      }
      bytes.set(next.value, length)
      length += next.value.byteLength
    }
    return overflow ? "" : new TextDecoder().decode(bytes.subarray(0, length))
  })
  if (overflow) throw new Error("Source output exceeded its byte limit")
  if (signal?.aborted) throw new Error("Source read cancelled")
  return result
}

/** Deliver only bounded lines, including when a producer sends one huge chunk. */
export async function consumeFeatureLines(
  stream: ReadableStream<Uint8Array>,
  consume: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const pending = new Uint8Array(outputLimit)
  let length = 0
  await withReader(stream, signal, async (reader) => {
    while (true) {
      const next = await reader.read()
      if (next.done || signal?.aborted) return
      const bytes = next.value
      let offset = 0
      while (offset < bytes.byteLength) {
        if (signal?.aborted) return
        const newline = bytes.indexOf(10, offset)
        const end = newline < 0 ? bytes.byteLength : newline
        const size = end - offset
        if (size > outputLimit - length)
          throw new Error("Feature line exceeded its byte limit")
        pending.set(bytes.subarray(offset, end), length)
        length += size
        if (newline < 0) break
        if (length)
          consume(new TextDecoder().decode(pending.subarray(0, length)))
        length = 0
        offset = newline + 1
      }
    }
  })
}

export async function readProcessOutput(
  command: string[],
  options: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
): Promise<string> {
  if (options.signal?.aborted) throw new Error("Metadata read cancelled")
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  } catch {
    throw new Error("Source command could not start")
  }
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => {
    child.kill("SIGKILL")
    controller.abort()
  }
  options.signal?.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    cancel()
  }, options.timeoutMs ?? 3_000)
  const output = readBoundedText(
    child.stdout as ReadableStream<Uint8Array>,
    controller.signal,
  )
  const diagnostics = drainDiagnostics(
    child.stderr as ReadableStream<Uint8Array>,
    controller.signal,
  )
  // Stop the producer immediately on reader failure, then join both pipes and exit.
  const guardedOutput = output.catch((error: unknown) => {
    cancel()
    throw error
  })
  const guardedDiagnostics = diagnostics.catch((error: unknown) => {
    cancel()
    if (error instanceof ReaderCleanupError) throw error
    throw new Error("Source diagnostics could not be drained")
  })
  try {
    const [out, err, exit] = await Promise.allSettled([
      guardedOutput,
      guardedDiagnostics,
      child.exited,
    ])
    if (
      (out.status === "rejected" && out.reason instanceof ReaderCleanupError) ||
      (err.status === "rejected" && err.reason instanceof ReaderCleanupError)
    )
      throw new ReaderCleanupError()
    if (options.signal?.aborted) throw new Error("Metadata read cancelled")
    if (timedOut) throw new Error("Source command timed out")
    if (out.status === "rejected")
      throw new Error("Source output exceeded its limit or could not be read")
    if (
      err.status === "rejected" ||
      exit.status === "rejected" ||
      exit.value !== 0
    )
      throw new Error("Source command failed")
    return out.value
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", cancel)
  }
}
