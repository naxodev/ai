import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Queue,
  Ref,
  Schedule,
  Semaphore,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import {
  emptyPlayer,
  type MusicChangeEvent,
  type PlayerState,
} from "../types.ts"
import { mergePlayer } from "../reconcile.ts"
import { MusicSessionConfig } from "./config.ts"
import type {
  ProtocolErrorCode,
  ProviderStatus,
  RevisionedState,
  TransportAction,
} from "./protocol.ts"
import { SessionProvider } from "./provider.ts"

export type CommandResult = { readonly action: TransportAction }
type CommandCode = Extract<
  ProtocolErrorCode,
  "SERVER_BUSY" | "DISPOSED" | "PROVIDER_FAILURE"
>
export class SessionCommandError extends Schema.TaggedErrorClass<SessionCommandError>()(
  "MusicSession.CommandError",
  {
    code: Schema.Literals(["SERVER_BUSY", "DISPOSED", "PROVIDER_FAILURE"]),
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const commandError = (
  code: CommandCode,
  operation: string,
  message: string,
  cause?: unknown,
): SessionCommandError =>
  new SessionCommandError(
    cause === undefined
      ? { code, operation, message }
      : { code, operation, message, cause: { cause } },
  )

type PollDeadline = {
  readonly revision: number
  readonly fiber: Fiber.Fiber<void, never> | undefined
}
type Job = {
  readonly action: TransportAction
  readonly positionMs?: number
  readonly result: Deferred.Deferred<CommandResult, SessionCommandError>
}
const instanceId = () =>
  `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** The sole state, command and scheduling authority for a daemon scope. */
export class MusicSessionCoordinator extends Context.Service<
  MusicSessionCoordinator,
  {
    readonly daemonInstanceId: string
    readonly status: Stream.Stream<ProviderStatus>
    readonly states: Stream.Stream<RevisionedState>
    readonly current: () => Effect.Effect<RevisionedState>
    readonly submit: (
      action: TransportAction,
      positionMs?: number,
    ) => Effect.Effect<CommandResult, SessionCommandError>
  }
>()("@naxodev/music-core/MusicSessionCoordinator") {}

export const layer = Layer.effect(
  MusicSessionCoordinator,
  Effect.gen(function* () {
    const config = (yield* MusicSessionConfig).options
    const provider = yield* SessionProvider
    const daemonInstanceId = instanceId()
    const statusRef = yield* SubscriptionRef.make<ProviderStatus>({
      kind: "unavailable",
      provider: null,
      message: "starting",
    })
    const stateRef = yield* SubscriptionRef.make<RevisionedState>({
      daemonInstanceId,
      revision: 0,
      state: emptyPlayer(),
    })
    const commands = yield* Queue.bounded<Job>(config.commandQueueCapacity)
    const lifecycle = yield* Ref.make({
      closed: false,
      pending: new Set<Job>(),
    })
    // The deadline fiber is intentionally separate from the sampling worker:
    // accepting a sample may replace the next deadline without interrupting the
    // sample that produced it.
    const pollFiber = yield* Ref.make<PollDeadline>({
      revision: -1,
      fiber: undefined,
    })
    const pollTriggers = yield* Queue.unbounded<void>()
    const sampling = yield* Ref.make({
      active: false,
      pending: false,
      generation: 0,
    })
    // Serializes trigger invalidation with a sample's stale check and commit.
    const samplingGate = yield* Semaphore.make(1)

    const setStatus = (value: ProviderStatus) =>
      SubscriptionRef.set(statusRef, value)
    // `stateRef.revision` is both the published revision and the authority
    // token. Every publication, including navigation authority invalidation,
    // is one atomic SubscriptionRef transition.
    const accept = Effect.fn("MusicSession.Coordinator.accept")(function* (
      state: PlayerState,
      merge: boolean,
      expectedRevision?: number,
    ) {
      const accepted = yield* SubscriptionRef.modify(stateRef, (previous) => {
        if (
          expectedRevision !== undefined &&
          previous.revision !== expectedRevision
        )
          return [false, previous] as const
        const next = merge ? mergePlayer(previous.state, state) : state
        return next
          ? [
              true,
              {
                daemonInstanceId,
                revision: previous.revision + 1,
                state: next,
              },
            ]
          : [false, previous]
      })
      if (accepted) yield* restartPoll()
      return accepted
    })
    const advanceAuthority = Effect.fn(
      "MusicSession.Coordinator.advanceAuthority",
    )(function* () {
      yield* SubscriptionRef.update(stateRef, (previous) => ({
        ...previous,
        revision: previous.revision + 1,
      }))
      yield* restartPoll()
    })

    const sample: (
      reason: string,
    ) => Effect.Effect<boolean, never, Scope.Scope> = Effect.fn(
      "MusicSession.Coordinator.sample",
    )(function* (_reason: string) {
      // Claim the single-flight lane atomically. A competing trigger marks the
      // active attempt stale and requests precisely one catch-up sample.
      const ticket = yield* samplingGate.withPermits(1)(
        Ref.modify(sampling, (current) => {
          const generation = current.generation + 1
          return current.active
            ? [undefined, { ...current, generation, pending: true }]
            : [generation, { active: true, pending: false, generation }]
        }),
      )
      if (ticket === undefined) return false

      const run = (
        ownedTicket: number,
      ): Effect.Effect<boolean, never, Scope.Scope> =>
        Effect.gen(function* () {
          const before = (yield* SubscriptionRef.get(stateRef)).revision
          let accepted = false
          const sampled = yield* Effect.match(provider.sample(), {
            onSuccess: (value) => ({ _tag: "Success" as const, value }),
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
          })
          if (sampled._tag === "Success") {
            accepted = yield* samplingGate.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* Ref.get(sampling)
                return current.generation === ownedTicket && sampled.value
                  ? yield* accept(sampled.value, true, before)
                  : false
              }),
            )
          } else {
            const current = yield* SubscriptionRef.get(statusRef)
            yield* setStatus({
              ...current,
              kind: current.kind === "ready" ? "degraded" : current.kind,
              message: "provider sample failed",
            })
          }
          // Transfer ownership directly to the coalesced pass. The lane never
          // becomes idle between completion and that pass's claim.
          const nextTicket = yield* Ref.modify(sampling, (current) => {
            if (!current.pending)
              return [undefined, { ...current, active: false, pending: false }]
            const generation = current.generation + 1
            return [generation, { active: true, pending: false, generation }]
          })
          return nextTicket === undefined ? accepted : yield* run(nextTicket)
        })
      return yield* run(ticket)
    })

    const restartPoll = Effect.fn("MusicSession.Coordinator.restartPoll")(
      function* () {
        const snapshot = yield* SubscriptionRef.get(stateRef)
        const delay = snapshot.state.is_playing
          ? config.pollMs.playing
          : snapshot.state.track
            ? config.pollMs.paused
            : config.pollMs.idle
        const next = yield* Effect.void.pipe(
          Effect.repeat(
            Schedule.spaced(delay).pipe(Schedule.upTo({ times: 1 })),
          ),
          Effect.flatMap(() => Queue.offer(pollTriggers, undefined)),
          Effect.asVoid,
          Effect.forkScoped,
        )
        // Do not let a delayed older accept replace a deadline installed for a
        // newer revision. Interrupt an uninstalled candidate immediately.
        const installed = yield* Ref.modify(
          pollFiber,
          (
            current,
          ): readonly [
            {
              readonly installed: boolean
              readonly previous: Fiber.Fiber<void, never> | undefined
            },
            PollDeadline,
          ] =>
            current.revision > snapshot.revision
              ? [{ installed: false, previous: undefined }, current]
              : [
                  { installed: true, previous: current.fiber },
                  { revision: snapshot.revision, fiber: next },
                ],
        )
        if (installed.installed) {
          if (installed.previous) yield* Fiber.interrupt(installed.previous)
        } else yield* Fiber.interrupt(next)
      },
    )

    const reconcile = (action: TransportAction) =>
      sample("reconciliation").pipe(
        Effect.delay(
          action === "next" || action === "previous"
            ? config.reconciliationMs.navigation
            : config.reconciliationMs.transport,
        ),
        Effect.forkScoped,
        Effect.asVoid,
      )

    const removePending = (job: Job) =>
      Ref.update(lifecycle, (current) => {
        const pending = new Set(current.pending)
        pending.delete(job)
        return { ...current, pending }
      })
    const settleDisposed = Effect.gen(function* () {
      const jobs = yield* Ref.modify(lifecycle, (current) => [
        current.pending,
        { closed: true, pending: new Set<Job>() },
      ])
      yield* Queue.shutdown(commands)
      yield* Effect.forEach(
        jobs,
        (job) =>
          Deferred.fail(
            job.result,
            commandError("DISPOSED", "command", "coordinator is closed"),
          ),
        { discard: true },
      )
    })
    yield* Effect.addFinalizer(() => settleDisposed)

    const worker = Effect.forever(
      Effect.gen(function* () {
        const job = yield* Queue.take(commands)
        const snapshot = yield* SubscriptionRef.get(stateRef)
        const action =
          job.action === "toggle"
            ? snapshot.state.is_playing
              ? "pause"
              : "play"
            : job.action
        const outcome = yield* Effect.match(
          provider.transport(action, job.positionMs),
          {
            onSuccess: () => ({ _tag: "Success" as const }),
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
          },
        )
        if (outcome._tag === "Failure") {
          yield* Deferred.fail(
            job.result,
            commandError(
              "PROVIDER_FAILURE",
              "transport",
              "provider transport failed",
              outcome.error,
            ),
          )
          yield* removePending(job)
          yield* sample("command-failure").pipe(Effect.forkScoped)
          return
        }
        const current = yield* SubscriptionRef.get(stateRef)
        if (action === "play" || action === "pause")
          yield* accept(
            {
              ...current.state,
              is_playing: action === "play",
              fetched_at: Date.now(),
            },
            false,
          )
        if (action === "seek")
          yield* accept(
            {
              ...current.state,
              progress_ms: Math.min(
                job.positionMs ?? 0,
                current.state.track?.duration_ms || job.positionMs || 0,
              ),
              fetched_at: Date.now(),
            },
            false,
          )
        // Navigation has no safe optimistic replacement state, but it is still
        // authoritative provider work: a pre-navigation sample must not win.
        if (action === "next" || action === "previous")
          yield* advanceAuthority()
        yield* Deferred.succeed(job.result, { action: job.action })
        yield* removePending(job)
        yield* reconcile(action)
      }),
    )
    yield* worker.pipe(Effect.forkScoped)
    yield* Effect.forever(
      Queue.take(pollTriggers).pipe(
        Effect.flatMap(() => sample("poll")),
        Effect.flatMap((accepted) => (accepted ? Effect.void : restartPoll())),
      ),
    ).pipe(Effect.forkScoped)

    const events = provider.events.pipe(
      Stream.runForEach((event: MusicChangeEvent) =>
        event.type === "snapshot"
          ? accept(event.state, false)
          : sample("invalidation").pipe(Effect.forkScoped, Effect.asVoid),
      ),
    )
    yield* events.pipe(
      Effect.catch(() => sample("provider-event-failure")),
      Effect.forkScoped,
    )

    const initialStatus = yield* provider.status().pipe(
      Effect.catch(() =>
        Effect.succeed<ProviderStatus>({
          kind: "unavailable",
          provider: null,
          message: "provider status unavailable",
        }),
      ),
    )
    yield* setStatus(initialStatus)
    yield* sample("initial")
    yield* restartPoll()

    const submit = Effect.fn("MusicSession.Coordinator.submit")(function* (
      action: TransportAction,
      positionMs?: number,
    ) {
      const result = yield* Deferred.make<CommandResult, SessionCommandError>()
      const job: Job =
        positionMs === undefined
          ? { action, result }
          : { action, positionMs, result }
      // Register before offering. Scope closure can therefore settle this
      // caller even if it races queue shutdown or a fast worker completion.
      const enrolled = yield* Ref.modify(lifecycle, (current) =>
        current.closed
          ? [false, current]
          : [true, { ...current, pending: new Set([...current.pending, job]) }],
      )
      if (!enrolled)
        return yield* Effect.fail(
          commandError("DISPOSED", "command", "coordinator is closed"),
        )
      const offered = yield* Effect.sync(() => Queue.offerUnsafe(commands, job))
      if (!offered) {
        const closed = (yield* Ref.get(lifecycle)).closed
        if (!closed) {
          yield* removePending(job)
          return yield* Effect.fail(
            commandError("SERVER_BUSY", "command", "command queue is full"),
          )
        }
      }
      return yield* Deferred.await(result)
    })
    return MusicSessionCoordinator.of({
      daemonInstanceId,
      status: SubscriptionRef.changes(statusRef),
      states: SubscriptionRef.changes(stateRef),
      current: () => SubscriptionRef.get(stateRef),
      submit,
    })
  }),
)
