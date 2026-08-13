#!/usr/bin/env node
import { Effect, Layer } from "effect"
import { layer as configLayer } from "./config.ts"
import { layer as providerLayer } from "./provider.ts"
import { layer as coordinatorLayer } from "./coordinator.ts"
import { layer as serverLayer, MusicSessionServerService } from "./server.ts"

function usage() {
  console.log("Usage: naxodev-music-sessiond --socket <absolute-path>")
}
function socketArgument(argv: string[]): string {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage()
    process.exit(0)
  }
  const index = argv.indexOf("--socket")
  const value = index >= 0 ? argv[index + 1] : undefined
  if (!value || !value.startsWith("/"))
    throw new Error("--socket requires an absolute Unix socket path")
  return value
}

const formatDaemonError = (error: unknown) => {
  const tagged =
    typeof error === "object" && error !== null
      ? (error as { readonly _tag?: unknown; readonly operation?: unknown })
      : undefined
  const tag = typeof tagged?._tag === "string" ? `${tagged._tag} ` : ""
  const operation =
    typeof tagged?.operation === "string" ? `[${tagged.operation}] ` : ""
  const message = error instanceof Error ? error.message : String(error)
  return `${tag}${operation}${message}`
}

type SignalEmitter = {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
}

/** Scoped signal boundary; the injectable emitter keeps listener ownership testable. */
export const waitForSignal = (signals: SignalEmitter = process) =>
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
    return Effect.sync(remove)
  })

const main = async () => {
  try {
    const socketPath = socketArgument(process.argv.slice(2))
    const coordinatorWithProvider = Layer.provide(
      coordinatorLayer,
      providerLayer,
    )
    const serverWithCoordinator = Layer.provide(
      serverLayer,
      coordinatorWithProvider,
    )
    const graph = Layer.provide(
      serverWithCoordinator,
      configLayer({ socketPath }),
    )
    let cleanupFailure: (() => unknown) | undefined
    let cleanupFailures: (() => ReadonlyArray<unknown>) | undefined
    const daemon = Effect.scoped(
      Effect.gen(function* () {
        const server = yield* MusicSessionServerService
        cleanupFailure = server.failure
        cleanupFailures = server.cleanupFailures
        console.error(
          `music-sessiond listening on ${socketPath} (${server.coordinator.daemonInstanceId})`,
        )
        yield* Effect.raceFirst(waitForSignal(), server.awaitFailure)
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
      console.error(
        `music-sessiond cleanup failures: ${cleanup.map(String).join("; ")}`,
      )
    if (daemonFailure) throw daemonFailure
    const failure = cleanupFailure?.()
    if (failure) throw failure
    console.error("music-sessiond stopped")
  } catch (error) {
    console.error(`music-sessiond: ${formatDaemonError(error)}`)
    process.exitCode = 1
  }
}

if (
  process.argv[1]?.endsWith("music-sessiond.ts") ||
  process.argv[1]?.endsWith("music-sessiond.js")
)
  await main()
