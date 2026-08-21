import {
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Queue,
  Ref,
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
import { decodeArtworkResult } from "./protocol.ts"
import type {
  ArtworkIdentity,
  ArtworkResult,
  ProtocolErrorCode,
  ProviderStatus,
  RevisionedState,
  TransportAction,
} from "./protocol.ts"
import { ProviderError, SessionProvider } from "./provider.ts"

export type CommandResult = { readonly action: TransportAction }
type CommandCode = Extract<
  ProtocolErrorCode,
  "SERVER_BUSY" | "DISPOSED" | "PROVIDER_FAILURE"
>
export class SessionCommandError extends Schema.TaggedError<SessionCommandError>()(
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

export type PollDeadline = {
  readonly revision: number
  readonly fiber: Fiber.Fiber<void, never> | undefined
}

type PollReservation = {
  readonly reserved: boolean
  readonly previous: Fiber.Fiber<void, never> | undefined
}

/** Atomically reserve a deadline revision; stale installers lose to authority. */
export const reservePollDeadline = (
  deadlines: Ref.Ref<PollDeadline>,
  revision: number,
): Effect.Effect<PollReservation> =>
  Ref.modify<PollDeadline, PollReservation>(deadlines, (current) =>
    current.revision > revision
      ? [{ reserved: false, previous: undefined }, current]
      : [
          { reserved: true, previous: current.fiber },
          { revision, fiber: undefined },
        ],
  )

/** Attach only to the reservation still owned by this deadline candidate. */
export const attachPollDeadline = (
  deadlines: Ref.Ref<PollDeadline>,
  revision: number,
  fiber: Fiber.Fiber<void, never>,
): Effect.Effect<boolean> =>
  Ref.modify(deadlines, (current) =>
    current.revision === revision && current.fiber === undefined
      ? [true, { ...current, fiber }]
      : [false, current],
  )

export type SamplingState = {
  readonly active: boolean
  readonly pending: boolean
  readonly generation: number
}

/** Atomically claim or coalesce a sample; an active ticket becomes stale. */
export const claimSampling = (
  sampling: Ref.Ref<SamplingState>,
): Effect.Effect<number | undefined> =>
  Ref.modify(sampling, (current) => {
    const generation = current.generation + 1
    return current.active
      ? [undefined, { ...current, generation, pending: true }]
      : [generation, { active: true, pending: false, generation }]
  })
type ArtworkAdmission =
  | {
      readonly type: "join"
      readonly deferred: Deferred.Deferred<ArtworkResult, ProviderError>
    }
  | {
      readonly type: "own"
      readonly deferred: Deferred.Deferred<ArtworkResult, ProviderError>
    }
  | { readonly type: "busy" }
type Job = {
  readonly action: TransportAction
  readonly positionMs?: number
  readonly result: Deferred.Deferred<CommandResult, SessionCommandError>
}
const instanceId = () => `music-session-${Math.random().toString(36).slice(2)}`

const samePlayerState = (left: PlayerState, right: PlayerState) =>
  left.is_playing === right.is_playing &&
  left.progress_ms === right.progress_ms &&
  left.shuffle === right.shuffle &&
  left.repeat === right.repeat &&
  left.fetched_at === right.fetched_at &&
  left.track?.id === right.track?.id &&
  left.track?.name === right.track?.name &&
  left.track?.artists === right.track?.artists &&
  left.track?.album === right.track?.album &&
  left.track?.uri === right.track?.uri &&
  left.track?.duration_ms === right.track?.duration_ms &&
  left.device?.id === right.device?.id &&
  left.device?.name === right.device?.name &&
  left.device?.type === right.device?.type &&
  left.device?.is_active === right.device?.is_active &&
  left.device?.volume_percent === right.device?.volume_percent &&
  left.device?.supports_volume === right.device?.supports_volume

/** The sole state, command and scheduling authority for a daemon scope. */
export class MusicSessionCoordinator extends Context.Service<
  MusicSessionCoordinator,
  {
    readonly daemonInstanceId: string
    readonly status: Stream.Stream<ProviderStatus>
    readonly states: Stream.Stream<RevisionedState>
    readonly current: () => Effect.Effect<RevisionedState>
    readonly artwork: (
      identity: ArtworkIdentity,
    ) => Effect.Effect<ArtworkResult, import("./provider.ts").ProviderError>
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
    const coordinatorScope = yield* Scope.Scope
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
    const artworkStore = yield* Ref.make({
      settled: new Map<string, ArtworkResult>(),
      inFlight: new Map<
        string,
        Deferred.Deferred<ArtworkResult, ProviderError>
      >(),
    })
    const artworkKey = (identity: ArtworkIdentity) => JSON.stringify(identity)
    const matchesArtwork = (state: PlayerState, identity: ArtworkIdentity) => {
      const track = state.track
      return (
        !!track &&
        track.id === identity.id &&
        track.name === identity.name &&
        track.artists === identity.artists &&
        track.album === identity.album &&
        track.duration_ms === identity.duration_ms
      )
    }
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
    const pollTriggers = yield* Queue.sliding<void>(1)
    const sampling = yield* Ref.make<SamplingState>({
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
        // Polling commonly returns the authoritative state unchanged. Such a
        // sample is not an authority transition and must not churn revisions
        // or continually replace an otherwise valid deadline.
        if (!next || (merge && samePlayerState(next, previous.state)))
          return [false, previous]
        return [
          true,
          {
            daemonInstanceId,
            revision: previous.revision + 1,
            state: next,
          },
        ]
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

    // Claiming is separate from provider work so event consumption can make a
    // competing sample stale before the provider fiber is scheduled.
    const claimSample = Effect.fn("MusicSession.Coordinator.claimSample")(
      function* () {
        return yield* samplingGate.withPermits(1)(claimSampling(sampling))
      },
    )
    const runSample = (
      ticket: number,
    ): Effect.Effect<boolean, never, Scope.Scope> => {
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
          const nextTicket = yield* samplingGate.withPermits(1)(
            Ref.modify(sampling, (current) => {
              if (!current.pending)
                return [
                  undefined,
                  { ...current, active: false, pending: false },
                ] as const
              const generation = current.generation + 1
              return [
                generation,
                { active: true, pending: false, generation },
              ] as const
            }),
          )
          return nextTicket === undefined ? accepted : yield* run(nextTicket)
        })
      return run(ticket)
    }
    const sample: (
      reason: string,
    ) => Effect.Effect<boolean, never, Scope.Scope> = Effect.fn(
      "MusicSession.Coordinator.sample",
    )(function* (_reason: string) {
      const ticket = yield* claimSample()
      return ticket === undefined ? false : yield* runSample(ticket)
    })

    const restartPoll = Effect.fn("MusicSession.Coordinator.restartPoll")(
      function* () {
        const snapshot = yield* SubscriptionRef.get(stateRef)
        const delay = snapshot.state.is_playing
          ? config.pollMs.playing
          : snapshot.state.track
            ? config.pollMs.paused
            : config.pollMs.idle
        // Reserve the revision before creating a sleeper. A newer revision can
        // therefore reject an older candidate even if it yielded after reading
        // its snapshot but before it could install a fiber.
        const reservation = yield* reservePollDeadline(
          pollFiber,
          snapshot.revision,
        )
        if (!reservation.reserved) return
        if (reservation.previous) yield* Fiber.interrupt(reservation.previous)
        const next = yield* Effect.sleep(delay).pipe(
          Effect.flatMap(() => Ref.get(pollFiber)),
          Effect.flatMap((current) =>
            current.revision === snapshot.revision
              ? Queue.offer(pollTriggers, undefined)
              : Effect.void,
          ),
          Effect.asVoid,
          Effect.forkScoped,
        )
        const attached = yield* attachPollDeadline(
          pollFiber,
          snapshot.revision,
          next,
        )
        if (!attached) yield* Fiber.interrupt(next)
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
        const now = yield* Clock.currentTimeMillis
        // Commit projections against the state that exists *after* transport.
        // A concurrent complete snapshot can therefore never be rolled back by
        // a stale full-state object captured before the transport completed.
        if (action === "play" || action === "pause")
          yield* SubscriptionRef.modify(stateRef, (current) => [
            true,
            {
              daemonInstanceId,
              revision: current.revision + 1,
              state: {
                ...current.state,
                is_playing: action === "play",
                fetched_at: now,
              },
            },
          ])
        if (action === "seek")
          yield* SubscriptionRef.modify(stateRef, (current) => {
            const requested = Math.max(0, job.positionMs ?? 0)
            const duration = current.state.track?.duration_ms
            return [
              true,
              {
                daemonInstanceId,
                revision: current.revision + 1,
                state: {
                  ...current.state,
                  progress_ms:
                    duration && duration > 0
                      ? Math.min(requested, duration)
                      : requested,
                  fetched_at: now,
                },
              },
            ]
          })
        if (action === "play" || action === "pause" || action === "seek")
          yield* restartPoll()
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
          : claimSample().pipe(
              Effect.flatMap((ticket) =>
                ticket === undefined
                  ? Effect.void
                  : runSample(ticket).pipe(Effect.forkScoped, Effect.asVoid),
              ),
            ),
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

    const artwork = (identity: ArtworkIdentity) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const before = yield* SubscriptionRef.get(stateRef)
          if (!matchesArtwork(before.state, identity))
            return { type: "stale" } as const
          const key = artworkKey(identity)
          const deferred = yield* Deferred.make<ArtworkResult, ProviderError>()
          const admission = yield* Ref.modify<
            {
              settled: Map<string, ArtworkResult>
              inFlight: Map<
                string,
                Deferred.Deferred<ArtworkResult, ProviderError>
              >
            },
            | ArtworkAdmission
            | { readonly type: "hit"; readonly result: ArtworkResult }
          >(artworkStore, (store) => {
            const hit = store.settled.get(key)
            if (hit) return [{ type: "hit" as const, result: hit }, store]
            const existing = store.inFlight.get(key)
            if (existing)
              return [{ type: "join" as const, deferred: existing }, store]
            if (store.inFlight.size >= config.artworkCacheCapacity)
              return [{ type: "busy" as const }, store]
            const settled = new Map(store.settled)
            while (
              settled.size + store.inFlight.size >=
              config.artworkCacheCapacity
            )
              settled.delete(settled.keys().next().value!)
            const inFlight = new Map(store.inFlight)
            inFlight.set(key, deferred)
            return [
              { type: "own" as const, deferred },
              { settled, inFlight },
            ]
          })
          if (admission.type === "hit") return admission.result
          if (admission.type === "busy")
            return yield* Effect.fail(
              new ProviderError({
                operation: "artwork",
                message: "artwork cache is full",
                cause: { cause: new Error("artwork cache is full") },
              }),
            )
          if (admission.type === "join")
            return yield* restore(Deferred.await(admission.deferred))
          const interrupted = new ProviderError({
            operation: "artwork",
            message: "artwork lookup interrupted",
            cause: { cause: new Error("artwork lookup interrupted") },
          })
          const complete = (exit: {
            readonly result?: ArtworkResult
            readonly error?: ProviderError
          }): Effect.Effect<void> =>
            Effect.uninterruptible(
              Ref.modify(artworkStore, (store) => {
                // A newer generation may own this key only after this exact deferred is gone.
                if (store.inFlight.get(key) !== admission.deferred)
                  return [false, store] as const
                const inFlight = new Map(store.inFlight)
                inFlight.delete(key)
                const settled = new Map(store.settled)
                if (exit.result?.type === "available")
                  settled.set(key, exit.result)
                return [true, { settled, inFlight }] as const
              }).pipe(
                Effect.flatMap((owned) =>
                  !owned
                    ? Effect.void
                    : exit.error
                      ? Deferred.fail(admission.deferred, exit.error)
                      : Deferred.succeed(admission.deferred, exit.result!),
                ),
              ),
            )
          const workflow = provider
            .nativeArtwork(identity, config.nativeArtworkMaxBytes)
            .pipe(
              Effect.match({
                onSuccess: (value) => ({ ok: true as const, value }),
                onFailure: (error) => ({ ok: false as const, error }),
              }),
              Effect.flatMap((outcome) => {
                if (!outcome.ok) return complete({ error: outcome.error })
                return SubscriptionRef.get(stateRef).pipe(
                  Effect.flatMap((after) => {
                    let validated: ArtworkResult
                    try {
                      validated = decodeArtworkResult(outcome.value)
                    } catch {
                      validated = { type: "unavailable" }
                    }
                    const padding =
                      validated.type === "available"
                        ? validated.base64.endsWith("==")
                          ? 2
                          : validated.base64.endsWith("=")
                            ? 1
                            : 0
                        : 0
                    const decodedBytes =
                      validated.type === "available"
                        ? (validated.base64.length / 4) * 3 - padding
                        : 0
                    const value =
                      decodedBytes > config.nativeArtworkMaxBytes
                        ? ({ type: "too-large" } as const)
                        : validated
                    return complete({
                      result: matchesArtwork(after.state, identity)
                        ? value
                        : { type: "stale" },
                    })
                  }),
                )
              }),
              Effect.catchCause(() => complete({ error: interrupted })),
              Effect.onInterrupt(() => complete({ error: interrupted })),
            )
          yield* Effect.forkIn(coordinatorScope)(workflow)
          return yield* restore(Deferred.await(admission.deferred))
        }),
      )
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
      // Admission and lifecycle enrollment share the explicit command bound:
      // one active job plus the queue's configured capacity. This keeps the
      // close-safe registry from becoming a second unbounded queue.
      const admission = yield* Ref.modify(lifecycle, (current) => {
        if (current.closed) return ["closed" as const, current]
        if (current.pending.size >= config.commandQueueCapacity + 1)
          return ["busy" as const, current]
        return [
          "enrolled" as const,
          { ...current, pending: new Set([...current.pending, job]) },
        ]
      })
      if (admission === "closed")
        return yield* Effect.fail(
          commandError("DISPOSED", "command", "coordinator is closed"),
        )
      if (admission === "busy")
        return yield* Effect.fail(
          commandError("SERVER_BUSY", "command", "command queue is full"),
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
      artwork,
      submit,
    })
  }),
)
