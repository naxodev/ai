#!/usr/bin/env node
import { Deferred, Effect, Fiber, Layer } from "effect"
import {
  layer as configLayer,
  resolveMusicSessionRuntimePaths,
  type MusicSessionOptions,
  type MusicSessionRuntimePaths,
} from "./config.ts"
import { layer as serverLayer, MusicSessionServerService } from "./server.ts"

function usage() {
  console.log("Usage: naxodev-music-sessiond [--socket <absolute-path>]")
}
function socketArgument(argv: readonly string[]): string | undefined {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage()
    process.exit(0)
  }
  const index = argv.indexOf("--socket")
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (!value || !value.startsWith("/"))
    throw new Error("--socket requires an absolute Unix socket path")
  return value
}

const formatDaemonError = (error: unknown) => {
  const tagged =
    typeof error === "object" && error !== null
      ? (error as {
          readonly _tag?: unknown
          readonly operation?: unknown
          readonly path?: unknown
        })
      : undefined
  const tag = typeof tagged?._tag === "string" ? `${tagged._tag} ` : ""
  const operation =
    typeof tagged?.operation === "string" ? `[${tagged.operation}] ` : ""
  const path = typeof tagged?.path === "string" ? `${tagged.path}: ` : ""
  const message = error instanceof Error ? error.message : String(error)
  return `${tag}${operation}${path}${message}`
}

type SignalEmitter = {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
}

/** Scoped signal boundary; the injectable emitter keeps listener ownership testable. */
export const waitForSignal = (
  signals: SignalEmitter = process,
  onListening?: () => void,
) =>
  Effect.callback<void>((resume) => {
    let stopped = false
    const remove = () => {
      signals.off("SIGINT", stop)
      signals.off("SIGTERM", stop)
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      remove()
      resume(Effect.void)
    }
    signals.once("SIGINT", stop)
    signals.once("SIGTERM", stop)
    onListening?.()
    return Effect.sync(remove)
  })

const productionGraph = (options: MusicSessionOptions) =>
  Layer.provide(serverLayer, configLayer(options))

/** Narrow executable seam; production continues to use the defaults below. */
export type MusicSessionDaemonOptions = {
  readonly argv?: readonly string[]
  /** Test-only managed runtime seam; production resolves its fixed /tmp layout. */
  readonly runtime?: MusicSessionRuntimePaths
  readonly graph?: (
    options: MusicSessionOptions,
  ) => ReturnType<typeof productionGraph>
  readonly signals?: SignalEmitter
  readonly diagnostic?: (message: string) => void
  readonly setStatus?: (status: number) => void
}

/**
 * Runs the executable's real scoped graph and retains cleanup diagnostics after
 * scope closure. Tests may replace only process-boundary dependencies.
 */
export const runMusicSessionDaemon = async (
  options: MusicSessionDaemonOptions = {},
): Promise<void> => {
  const diagnostic = options.diagnostic ?? console.error
  const setStatus =
    options.setStatus ?? ((status) => (process.exitCode = status))
  try {
    const explicitSocket = socketArgument(options.argv ?? process.argv.slice(2))
    const runtime = explicitSocket
      ? undefined
      : (options.runtime ?? resolveMusicSessionRuntimePaths())
    const socketPath = explicitSocket ?? runtime!.socketPath
    const graphOptions = explicitSocket ? { socketPath } : { runtime: runtime! }
    const graph = options.graph
      ? options.graph(graphOptions)
      : productionGraph(graphOptions)
    let cleanupFailure: (() => unknown) | undefined
    let cleanupFailures: (() => ReadonlyArray<unknown>) | undefined
    const daemon = Effect.scoped(
      Effect.gen(function* () {
        const server = yield* MusicSessionServerService
        cleanupFailure = server.failure
        cleanupFailures = server.cleanupFailures
        const signalReady = Deferred.makeUnsafe<void>()
        const signal = yield* waitForSignal(options.signals, () => {
          Deferred.doneUnsafe(signalReady, Effect.void)
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(signalReady)
        diagnostic(
          `music-sessiond listening on ${socketPath} (${server.coordinator.daemonInstanceId})`,
        )
        yield* Effect.raceFirst(Fiber.join(signal), server.awaitFailure)
      }).pipe(Effect.provide(graph)),
    )
    let daemonFailure: unknown
    try {
      await Effect.runPromise(daemon)
    } catch (error) {
      daemonFailure = error
    }
    const cleanup = cleanupFailures?.() ?? []
    if (daemonFailure && cleanup.length > 0)
      diagnostic(
        `music-sessiond cleanup failures: ${cleanup.map(formatDaemonError).join("; ")}`,
      )
    if (daemonFailure) throw daemonFailure
    const failure = cleanupFailure?.() ?? cleanup[0]
    if (failure) throw failure
    diagnostic("music-sessiond stopped")
  } catch (error) {
    diagnostic(`music-sessiond: ${formatDaemonError(error)}`)
    setStatus(1)
  }
}

if (
  process.argv[1]?.endsWith("music-sessiond.ts") ||
  process.argv[1]?.endsWith("music-sessiond.js")
)
  await runMusicSessionDaemon()
