/** Shared ownership for the two bounded, discovery-only process boundaries. */
import { Buffer } from "node:buffer"
import { Cause, Effect, Exit, Result, Schedule, Scope, Stream } from "effect"
import type { AudioAdapterError } from "../../audio/capture.ts"
import {
  cleanHelperExit,
  helperError,
  liveNativeHelperDependencies,
  makeHelperTermination,
  type NativeHelperDependencies,
  type NativeHelperExit,
} from "../../audio/helper-process.ts"
import { withProbeDiagnostics, type ProbeDiagnostic } from "./diagnostics.ts"

export type DiscoveryResult<Summary> =
  | {
      status: "checked"
      summary: Summary
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

type ReadJson = (
  args: readonly string[],
) => Effect.Effect<unknown, AudioAdapterError, Scope.Scope>
type DiscoveryPlan<Summary> = {
  helperPath: string
  helperIdentifier: string
  metadataFlags: readonly string[]
  discoveryFlag: string
  prepare: (
    boundary: NativeHelperDependencies,
    readJson: ReadJson,
  ) => Effect.Effect<
    readonly string[] | undefined,
    AudioAdapterError,
    Scope.Scope
  >
  decode: (value: unknown) => Effect.Effect<Summary, AudioAdapterError>
}

export const makeDiscoveryInspector = <Summary>(plan: DiscoveryPlan<Summary>) =>
  Effect.fn("SckDiscovery.inspect")(function* (
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
              request.executable !== plan.helperPath ||
              request.shell !== false ||
              ![...plan.metadataFlags, plan.discoveryFlag].includes(
                request.args[0] ?? "",
              )
            )
              throw new Error("Unexpected discovery helper command")
            const child = raw.spawn(request)
            return request.args[0] === plan.discoveryFlag
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
        const readJson: ReadJson = Effect.fn("SckDiscovery.readJson")(
          function* (args: readonly string[]) {
            const child = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const process = yield* Effect.try({
                  try: () =>
                    boundary.spawn({
                      executable: plan.helperPath,
                      shell: false,
                      args: [...args],
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
                  exit.code === 77 && exit.signal === null
                    ? "permission"
                    : "setup",
                ),
              )
            return yield* Effect.try({
              try: (): unknown =>
                JSON.parse(bytes.subarray(0, length).toString("utf8")),
              catch: () => helperError(),
            })
          },
        )
        if (!(yield* boundary.verify(plan.helperPath, plan.helperIdentifier)))
          return yield* Effect.fail(helperError("unavailable"))
        const args = yield* plan.prepare(boundary, readJson)
        if (!args)
          return {
            status: "unavailable",
            reason: "source-unavailable",
            nativeDiagnostics,
          } satisfies DiscoveryResult<Summary>
        if (!(yield* boundary.verify(plan.helperPath, plan.helperIdentifier)))
          return yield* Effect.fail(helperError("unavailable"))
        yield* beforeQuery
        const value = yield* readJson([plan.discoveryFlag, ...args])
        const summary = yield* plan.decode(value)
        return {
          status: "checked",
          summary,
          nativeDiagnostics,
        } satisfies DiscoveryResult<Summary>
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
    } satisfies DiscoveryResult<Summary>
  })
