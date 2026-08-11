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

const waitForSignal: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const stop = () => resume(Effect.void)
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  return Effect.sync(() => {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  })
})

try {
  const socketPath = socketArgument(process.argv.slice(2))
  const coordinatorWithProvider = Layer.provide(coordinatorLayer, providerLayer)
  const serverWithCoordinator = Layer.provide(
    serverLayer,
    coordinatorWithProvider,
  )
  const graph = Layer.provide(
    serverWithCoordinator,
    configLayer({ socketPath }),
  )
  const daemon = Effect.scoped(
    Effect.gen(function* () {
      const server = yield* MusicSessionServerService
      console.error(
        `music-sessiond listening on ${socketPath} (${server.coordinator.daemonInstanceId})`,
      )
      yield* waitForSignal
    }).pipe(Effect.provide(graph)),
  )
  await Effect.runPromise(daemon)
  console.error("music-sessiond stopped")
} catch (error) {
  console.error(
    `music-sessiond: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
}
