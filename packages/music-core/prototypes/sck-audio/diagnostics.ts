/** Fixed native statuses only. Never retain arbitrary stderr or audio. */
import { Buffer } from "node:buffer"
import { Effect, Fiber, Scope, Stream } from "effect"
import type { NativeHelperDependencies } from "../../audio/helper-process.ts"
import { sourceDiscovery } from "./source-discovery.ts"
import { applicationDiscovery } from "./application-discovery.ts"
import { safariExclusion } from "./safari-exclusion.ts"

export const sckSourceCheckpoints = [
  "sck-before-discovery-identity",
  "sck-before-discovery-ownership",
  "sck-discovery",
  "sck-application-absent",
  "sck-application-ambiguous",
  "sck-display-absent",
  "sck-after-discovery-identity",
  "sck-after-discovery-ownership",
  "sck-filter-app-count",
  "sck-filter-app-pid",
  "sck-filter-display-count",
  "sck-before-start-identity",
  "sck-before-start-ownership",
  "sck-running-identity",
  "sck-running-ownership",
] as const

const reasons = new Set([
  ...sckSourceCheckpoints,
  "application-profile",
  "application-signature",
  "application-before-identity",
  "application-before-witness",
  "application-discovery",
  "application-after-identity",
  "application-after-witness",
  "application-match-count",
  "application-match-pid",
  "application-display",
  "application-filter",
  "application-route",
  "application-before-start",
  "application-running-identity",
  "application-running-witness",
  "permission",
  "source-loss",
  "source-bound",
  "setup",
  "format",
  "clock",
  "cleanup-failed",
  "abnormal-deadline",
  "prototype-deadline",
  "unexpected-output",
  "analysis",
  "output-bound",
  "output-failed",
  "output-expired",
  "arguments",
  "lease-expired",
  "signal",
  "parent-disconnected",
  "control-failed",
  "control-bound",
])

export type ProbeDiagnostic = {
  command: "catalog" | "capture" | "discovery"
  reason: string
}

/** Own one diagnostic drain. Observation grants no capture or consent authority. */
export const withProbeDiagnostics = Effect.fn("SckProbe.withDiagnostics")(
  function* (
    boundary: NativeHelperDependencies,
    record: (diagnostic: ProbeDiagnostic) => void,
  ) {
    const owner = yield* Scope.Scope
    const dependencies: NativeHelperDependencies = {
      ...boundary,
      spawn: (request) => {
        const child = boundary.spawn(request)
        const command =
          request.args[0] === "--list-kaset-sources" ||
          request.args[0] === applicationDiscovery.preflightFlag ||
          request.args[0] === safariExclusion.preflightFlag
            ? "catalog"
            : request.args[0] === sourceDiscovery.nativeFlag ||
                request.args[0] === applicationDiscovery.nativeFlag
              ? "discovery"
              : "capture"
        const line = Buffer.alloc(256)
        let length = 0
        let bytes = 0
        let discard = false
        const worker = Effect.runSync(
          Effect.forkIn(
            child.stderr.pipe(
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  // Bound both work and storage even for hostile diagnostic output.
                  for (const byte of chunk) {
                    if (++bytes > 4096) break
                    if (byte !== 10) {
                      if (length === line.length) discard = true
                      if (!discard) line[length++] = byte
                      continue
                    }
                    if (!discard) {
                      const match = line
                        .subarray(0, length)
                        .toString("utf8")
                        .match(
                          /^\{"event":"music-audio-helper-stop","reason":"([a-z-]+)"\}$/,
                        )
                      const reason = match?.[1]
                      if (reason && reasons.has(reason))
                        record({ command, reason })
                    }
                    length = 0
                    discard = false
                  }
                }),
              ),
            ),
            owner,
          ),
        )
        return {
          ...child,
          stderr: Stream.fromEffect(Fiber.join(worker)).pipe(Stream.drain),
          // A fast exit can win before the adapter starts its diagnostic reader.
          // Wait only for its result after physical exit. The owning scope joins
          // cleanup; cancellation of this waiter must not join worker cleanup.
          exit: child.exit.pipe(
            Effect.tap(() =>
              Fiber.await(worker).pipe(
                Effect.timeoutOrElse({
                  duration: 50,
                  orElse: () => Effect.void,
                }),
                Effect.asVoid,
                Effect.ensuring(Effect.sync(() => worker.interruptUnsafe())),
              ),
            ),
          ),
        }
      },
    }
    return dependencies
  },
)
