/** Bounded metadata inspection. This boundary rejects every capture command. */
import { Buffer } from "node:buffer"
import { Cause, Effect, Exit, Result, Schedule, Schema, Stream } from "effect"
import type { AudioAdapterError } from "../../audio/capture.ts"
import {
  cleanHelperExit,
  helperError,
  liveNativeHelperDependencies,
  makeHelperTermination,
  type NativeHelperDependencies,
  type NativeHelperExit,
} from "../../audio/helper-process.ts"
import { readLocalKasetCatalog } from "../../audio/local-kaset.ts"
import {
  sckDependencies,
  sckHelperIdentifier,
  sckHelperPath,
} from "./adapter.ts"
import { withProbeDiagnostics, type ProbeDiagnostic } from "./diagnostics.ts"
import { sourceDiscovery } from "./source-discovery.ts"

const Count = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(65536),
)
const DiscoverySummary = Schema.Struct({
  event: Schema.Literal("sck-source-discovery"),
  identityChecks: Schema.Literal("passed-before-and-after"),
  attributionChecks: Schema.Literal("passed-before-and-after"),
  matchingApplications: Count,
  displayCount: Count,
})
interface DiscoverySummary extends Schema.Schema.Type<
  typeof DiscoverySummary
> {}

export type SourceDiscoveryResult =
  | {
      status: "checked"
      summary: DiscoverySummary
      nativeDiagnostics: ProbeDiagnostic[]
    }
  | {
      status: "unavailable"
      reason: "source-unavailable"
      nativeDiagnostics: ProbeDiagnostic[]
    }
  | {
      status: "failed"
      reason: "setup" | "permission" | "timeout" | "cleanup-failed"
      nativeDiagnostics: ProbeDiagnostic[]
    }

export const inspectSourceDiscovery = Effect.fn("SckDiscovery.inspect")(
  function* (
    beforeQuery: Effect.Effect<void, AudioAdapterError>,
    raw: NativeHelperDependencies = liveNativeHelperDependencies,
  ) {
    const nativeDiagnostics: ProbeDiagnostic[] = []
    let settledExit: NativeHelperExit | undefined
    let cleanupFailed = false
    const operation = Effect.scoped(
      Effect.gen(function* () {
        const guarded: NativeHelperDependencies = {
          ...raw,
          spawn: (request) => {
            if (
              request.executable !== sckHelperPath ||
              request.shell !== false ||
              !["--list-kaset-sources", sourceDiscovery.nativeFlag].includes(
                request.args[0] ?? "",
              )
            )
              throw new Error("Unexpected discovery helper command")
            const child = raw.spawn(request)
            return request.args[0] === sourceDiscovery.nativeFlag
              ? {
                  ...child,
                  exit: child.exit.pipe(
                    Effect.tap((exit) =>
                      Effect.sync(() => {
                        settledExit = exit
                      }),
                    ),
                  ),
                }
              : child
          },
        }
        const boundary = yield* withProbeDiagnostics(guarded, (diagnostic) => {
          if (nativeDiagnostics.length < 64) nativeDiagnostics.push(diagnostic)
        })
        const catalog = yield* readLocalKasetCatalog(
          sckDependencies(boundary),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const entry =
          catalog?.sources.length === 1 ? catalog.sources[0] : undefined
        if (!entry)
          return {
            status: "unavailable",
            reason: "source-unavailable",
            nativeDiagnostics,
          } satisfies SourceDiscoveryResult
        if (!(yield* boundary.verify(sckHelperPath, sckHelperIdentifier)))
          return yield* Effect.fail(helperError("unavailable"))
        // Source discovery accepts a verified paused source. It never requests audio.
        yield* beforeQuery
        const child = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const process = yield* Effect.try({
              try: () =>
                boundary.spawn({
                  executable: sckHelperPath,
                  shell: false,
                  args: [
                    sourceDiscovery.nativeFlag,
                    "--protocol",
                    "1",
                    "--process-id",
                    String(entry.identity.processIdentifier),
                    "--launch-identity",
                    entry.identity.launchIdentity,
                    "--executable-identity",
                    entry.identity.executableIdentity,
                    "--core-audio-object",
                    entry.identity.coreAudioObject,
                    "--attribution",
                    "kaset-cache-v1",
                  ],
                }),
              catch: () => helperError(),
            })
            const terminate = yield* makeHelperTermination(process)
            yield* Effect.addFinalizer(() =>
              terminate.pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (Exit.isFailure(exit)) cleanupFailed = true
                  }),
                ),
                Effect.orDie,
              ),
            )
            return process
          }),
        )
        yield* child.stderr.pipe(Stream.runDrain, Effect.forkScoped)
        const bytes = Buffer.alloc(4096)
        let length = 0
        const reading = child.stdout.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              if (length + chunk.byteLength > bytes.length)
                return yield* Effect.fail(helperError())
              bytes.set(chunk, length)
              length += chunk.byteLength
            }),
          ),
        )
        const heartbeat = child.heartbeat.pipe(
          Effect.repeat(Schedule.spaced("1 second")),
          Effect.andThen(Effect.never),
        )
        const abnormalExit = child.exit.pipe(
          Effect.flatMap((exit) =>
            cleanHelperExit(exit)
              ? Effect.never
              : Effect.fail(
                  helperError(
                    exit.code === 77 && exit.signal === null
                      ? "permission"
                      : "setup",
                  ),
                ),
          ),
        )
        yield* Effect.raceFirst(
          child.ready.pipe(
            Effect.andThen(Effect.raceFirst(reading, heartbeat)),
          ),
          abnormalExit,
        )
        const exit = yield* child.exit
        if (!cleanHelperExit(exit))
          return yield* Effect.fail(
            helperError(
              exit.code === 77 && exit.signal === null ? "permission" : "setup",
            ),
          )
        const value: unknown = yield* Effect.try({
          try: () => JSON.parse(bytes.subarray(0, length).toString("utf8")),
          catch: () => helperError(),
        })
        const decoded = yield* Schema.decodeUnknownEffect(DiscoverySummary)(
          value,
        ).pipe(Effect.mapError(() => helperError()))
        // Explicit projection prevents unknown native fields entering the artifact.
        const summary: DiscoverySummary = {
          event: decoded.event,
          identityChecks: decoded.identityChecks,
          attributionChecks: decoded.attributionChecks,
          matchingApplications: decoded.matchingApplications,
          displayCount: decoded.displayCount,
        }
        return {
          status: "checked",
          summary,
          nativeDiagnostics,
        } satisfies SourceDiscoveryResult
      }).pipe(
        Effect.timeoutOrElse({
          duration: "8 seconds",
          orElse: () => Effect.fail(helperError("timeout")),
        }),
      ),
    )
    const outcome = yield* operation.pipe(Effect.exit)
    if (Exit.isSuccess(outcome)) return outcome.value
    if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.interrupt
    const error = Cause.findError(outcome.cause)
    const reason = cleanupFailed
      ? "cleanup-failed"
      : settledExit?.code === 77 && settledExit.signal === null
        ? "permission"
        : Result.isSuccess(error) && error.success.reason === "timeout"
          ? "timeout"
          : "setup"
    return {
      status: "failed",
      reason,
      nativeDiagnostics,
    } satisfies SourceDiscoveryResult
  },
)
