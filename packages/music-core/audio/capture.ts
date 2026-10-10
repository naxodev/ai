import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Schedule,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  AUDIO_FEATURE_INTERVAL_MS,
  AUDIO_SELECTION_TOKEN_TTL_MS,
  AUDIO_INTEREST_LEASE_MS,
  AUDIO_STARTUP_INTEREST_MS,
  AUDIO_INTEREST_SWEEP_MS,
  AudioFeatureFrame,
  isPidReuse,
  MAX_AUDIO_FEATURE_FRAME_BYTES,
  MAX_AUDIO_SELECTIONS_PER_CONNECTION,
  MAX_AUDIO_SOURCES,
  sameCaptureIdentity,
  selectionMatchesIdentity,
  unavailableAudioSourceList,
  type AudioCaptureStatus,
  type AudioFeatureDraft,
  type AudioFeatureFrame as AudioFeatureFrameValue,
  type AudioSourceList,
  type AudioStartResult,
  type AudioStopResult,
  type AudioRenewResult,
  type CaptureIdentity,
  type ResolvedCaptureSource,
} from "./schema.ts"
import { localMonotonicMs } from "./clock.ts"
import {
  unavailableAudioSourceResolver,
  unavailableSourceObservations,
  type AudioSourceResolver,
  type ProviderSourceObservation,
} from "./source.ts"

export class AudioAdapterError extends Schema.TaggedError<AudioAdapterError>()(
  "AudioCapture.AdapterError",
  {
    reason: Schema.Literals(["unavailable", "setup", "timeout", "permission"]),
  },
) {}

/**
 * `start` runs in the capture owner's scope and may be interrupted.
 * Register cleanup with `Effect.addFinalizer` before any interruptible wait.
 * `Effect.acquireRelease` acquisition is uninterruptible, so a latch wait
 * inside acquire deadlocks cancellation. The frames stream ends the session
 * on completion or typed failure.
 */
export type AudioCaptureHandle = {
  readonly frames: Stream.Stream<AudioFeatureDraft, AudioAdapterError>
}

export type AudioCaptureAdapter = {
  readonly availability: "available" | "unavailable"
  readonly start: (
    source: ResolvedCaptureSource,
  ) => Effect.Effect<AudioCaptureHandle, AudioAdapterError, Scope.Scope>
}

export const unavailableAudioCaptureAdapter: AudioCaptureAdapter = {
  availability: "unavailable",
  start: () => Effect.fail(new AudioAdapterError({ reason: "unavailable" })),
}

type IssuedToken = {
  readonly token: string
  readonly connectionId: string
  readonly daemonInstanceId: string
  readonly expiresAtMs: number
  readonly source: ResolvedCaptureSource
}

type Attempt = {
  readonly id: number
  readonly connectionId: string
  readonly cancel: Deferred.Deferred<void>
  readonly done: Deferred.Deferred<void>
}

type Slot =
  | { readonly phase: "idle"; readonly generation: number }
  | {
      readonly phase: "acquiring" | "active" | "retiring"
      readonly generation: number
      readonly source: ResolvedCaptureSource
      readonly leases: ReadonlyMap<string, number>
      // Retain departing ownership while leases are revoked during retirement.
      readonly interestOwners: ReadonlyMap<string, ReadonlySet<number>>
      readonly departingLeases?: ReadonlyMap<string, number>
      readonly outcome: Deferred.Deferred<AudioStartResult>
      readonly done: Deferred.Deferred<void>
      readonly close: Effect.Effect<void> | undefined
      readonly leader: Fiber.Fiber<void> | undefined
    }

type CaptureState = {
  readonly closed: boolean
  readonly observationsClosed: boolean
  readonly slot: Slot
  readonly tokens: ReadonlyMap<string, IssuedToken>
  readonly attempts: ReadonlyMap<number, Attempt>
  readonly latestObservation: ProviderSourceObservation | undefined
}

type StopReason =
  "stop" | "last-connection" | "source-loss" | "canceled" | "lease-expired"

type RetirementReason =
  StopReason | { readonly failed: "setup" | "timeout" | "permission" }

const adapterFailureReason = (cause: Cause.Cause<AudioAdapterError>) => {
  const error = Cause.findError(cause)
  return Result.isSuccess(error) && error.success.reason !== "unavailable"
    ? error.success.reason
    : "setup"
}

type ExpireAction = {
  readonly generation: number
  readonly expired: ReadonlySet<string>
  readonly canceled: readonly Attempt[]
  readonly retiring:
    Extract<Slot, { phase: "acquiring" | "active" | "retiring" }> | undefined
}

type RetireAction =
  | { readonly type: "absent" }
  | {
      readonly type: "wait"
      readonly done: Deferred.Deferred<void>
      readonly authorized: boolean
    }
  | {
      readonly type: "retire"
      readonly generation: number
      readonly close: Effect.Effect<void> | undefined
      readonly done: Deferred.Deferred<void>
      readonly leader: Fiber.Fiber<void> | undefined
    }

type LeaveAction =
  | { readonly type: "none" | "remain" }
  | { readonly type: "wait"; readonly done: Deferred.Deferred<void> }
  | (Omit<Extract<RetireAction, { type: "retire" }>, "type"> & {
      readonly type: "last"
    })

type Claim =
  | { readonly type: "canceled" }
  | { readonly type: "wait"; readonly done: Deferred.Deferred<void> }
  | {
      readonly type: "leader"
      readonly generation: number
      readonly outcome: Deferred.Deferred<AudioStartResult>
      readonly source: ResolvedCaptureSource
    }
  | {
      readonly type: "waiter"
      readonly generation: number
      readonly outcome: Deferred.Deferred<AudioStartResult>
    }
  | {
      readonly type: "joined"
      readonly generation: number
      readonly source: CaptureIdentity
    }
  | { readonly type: "busy" }
  | { readonly type: "retry" }
  | { readonly type: "unknown-token" }
  | { readonly type: "expired-token" }
  | { readonly type: "unresolved-source" }
  | { readonly type: "expired-interest" }

const idleSlot = (generation: number): Slot => ({
  phase: "idle",
  generation,
})

const sameSelection = (
  left: ResolvedCaptureSource,
  right: ResolvedCaptureSource,
): boolean =>
  left.mode === right.mode && sameCaptureIdentity(left.identity, right.identity)

const canceledResult = {
  type: "rejected" as const,
  reason: "canceled" as const,
}

export class AudioCapture extends Context.Service<
  AudioCapture,
  {
    readonly listSources: (
      connectionId: string,
    ) => Effect.Effect<AudioSourceList>
    readonly start: (
      connectionId: string,
      token: string,
    ) => Effect.Effect<AudioStartResult>
    readonly stop: (connectionId: string) => Effect.Effect<AudioStopResult>
    readonly renew: (
      connectionId: string,
      generation: number,
    ) => Effect.Effect<AudioRenewResult>
    readonly subscribeStatus: (
      connectionId: string,
    ) => Stream.Stream<AudioCaptureStatus>
    readonly subscribeFeatures: (
      connectionId: string,
      options?: { readonly detachOnClose?: boolean },
    ) => Stream.Stream<AudioFeatureFrameValue>
    /** Revokes current authority and old tokens before returning. Cleanup starts
     * in the capture scope immediately. The reusable completion joins only the
     * captured retirement and attempts; it never deletes later tokens or leases.
     * Server-owned feature streams must set detachOnClose to false. */
    readonly beginDetach: (
      connectionId: string,
    ) => Effect.Effect<Effect.Effect<void>>
    readonly detach: (connectionId: string) => Effect.Effect<void>
    readonly status: () => Effect.Effect<AudioCaptureStatus>
  }
>()("@naxodev/music-core/AudioCapture") {}

export type AudioCaptureOptions = {
  readonly daemonInstanceId: string
  readonly resolver: AudioSourceResolver
  readonly adapter: AudioCaptureAdapter
  readonly observations: Stream.Stream<ProviderSourceObservation>
  readonly tokenTtlMs?: number
  readonly interestLeaseMs?: number
  readonly startupInterestMs?: number
  readonly nowMs?: () => number
}

export const makeAudioCapture = (options: AudioCaptureOptions) =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope
    const ttl = options.tokenTtlMs ?? AUDIO_SELECTION_TOKEN_TTL_MS
    const nowMs = options.nowMs ?? localMonotonicMs
    const interestLeaseMs = options.interestLeaseMs ?? AUDIO_INTEREST_LEASE_MS
    const startupInterestMs =
      options.startupInterestMs ?? AUDIO_STARTUP_INTEREST_MS
    const state = yield* Ref.make<CaptureState>({
      closed: false,
      observationsClosed: false,
      slot: idleSlot(0),
      tokens: new Map(),
      attempts: new Map(),
      latestObservation: undefined,
    })
    const status = yield* Ref.make<AudioCaptureStatus>(
      options.adapter.availability === "unavailable"
        ? { type: "unavailable", reason: "capture-adapter-unavailable" }
        : { type: "idle" },
    )
    const sequences = yield* Ref.make(0)
    const lastTimestamp = yield* Ref.make(-1)
    const lastEmitAt = yield* Ref.make(-1)
    const pendingDraft = yield* Ref.make<AudioFeatureDraft | undefined>(
      undefined,
    )
    const latestFrame = yield* Ref.make<AudioFeatureFrameValue | undefined>(
      undefined,
    )
    const featureEpoch = yield* Ref.make(0)
    let nextAttempt = 0
    let nextSink = 0
    const statusSinks = yield* Ref.make<
      Map<
        number,
        {
          readonly connectionId: string
          readonly offer: (status: AudioCaptureStatus) => void
        }
      >
    >(new Map())
    const featureSinks = yield* Ref.make<
      Map<
        number,
        {
          readonly connectionId: string
          readonly epoch: number
          readonly offer: (frame: AudioFeatureFrameValue) => void
        }
      >
    >(new Map())

    const publishStatus = (next: AudioCaptureStatus) =>
      Ref.set(status, next).pipe(
        Effect.andThen(Ref.get(statusSinks)),
        Effect.flatMap((sinks) =>
          Effect.forEach(
            [...sinks.values()],
            (sink) => Effect.sync(() => sink.offer(next)),
            { discard: true },
          ),
        ),
      )

    const joined = (
      current: CaptureState,
      connectionId: string,
      generation: number,
    ) =>
      current.slot.phase !== "idle" &&
      current.slot.generation === generation &&
      (current.slot.phase === "active" || current.slot.phase === "acquiring") &&
      (current.slot.leases.get(connectionId) ?? -Infinity) > nowMs()

    const publishFrame = (frame: AudioFeatureFrameValue) =>
      Ref.set(latestFrame, frame).pipe(
        Effect.andThen(Ref.get(state)),
        Effect.flatMap((current) =>
          Ref.get(featureSinks).pipe(
            Effect.flatMap((sinks) =>
              Effect.forEach(
                [...sinks.values()],
                (sink) =>
                  Effect.sync(() => {
                    if (joined(current, sink.connectionId, frame.generation))
                      sink.offer(frame)
                  }),
                { discard: true },
              ),
            ),
          ),
        ),
      )

    const clearFrames = Ref.set(latestFrame, undefined).pipe(
      Effect.andThen(Ref.update(featureEpoch, (epoch) => epoch + 1)),
    )

    const releaseRetiring = (generation: number, reason: RetirementReason) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const done = yield* Ref.get(state).pipe(
            Effect.map((current) => {
              if (
                current.slot.phase !== "retiring" ||
                current.slot.generation !== generation
              )
                return undefined
              return current.slot.done
            }),
          )
          if (done === undefined) return
          yield* Ref.set(sequences, 0)
          yield* Ref.set(lastTimestamp, -1)
          yield* Ref.set(pendingDraft, undefined)
          yield* Ref.set(pendingSlot, undefined)
          yield* clearFrames
          yield* publishStatus(
            typeof reason === "string"
              ? { type: "stopped", generation, reason }
              : { type: "failed", generation, reason: reason.failed },
          )
          yield* Ref.update(state, (current) =>
            current.slot.phase === "retiring" &&
            current.slot.generation === generation
              ? { ...current, slot: idleSlot(generation) }
              : current,
          )
          yield* Deferred.succeed(done, undefined)
        }),
      )

    const finishRetirement = (
      action: Extract<RetireAction, { type: "retire" }>,
      reason: RetirementReason,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (action.close) yield* action.close
          if (action.leader) yield* Fiber.interrupt(action.leader)
          yield* releaseRetiring(action.generation, reason)
          yield* Deferred.await(action.done)
        }),
      )

    const retire = (
      generation: number,
      reason: RetirementReason,
      requireLease?: string,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const action = yield* Ref.modify(
            state,
            (current): readonly [RetireAction, CaptureState] => {
              const slot = current.slot
              if (
                slot.phase === "retiring" &&
                (generation === 0 || slot.generation === generation) &&
                (requireLease === undefined ||
                  slot.interestOwners.has(requireLease))
              )
                return [
                  {
                    type: "wait",
                    done: slot.done,
                    authorized:
                      requireLease === undefined ||
                      (slot.departingLeases?.get(requireLease) ?? -Infinity) >
                        nowMs(),
                  },
                  current,
                ]
              if (slot.phase !== "acquiring" && slot.phase !== "active")
                return [{ type: "absent" }, current]
              if (generation !== 0 && slot.generation !== generation)
                return [{ type: "absent" }, current]
              if (
                requireLease !== undefined &&
                (slot.leases.get(requireLease) ?? -Infinity) <= nowMs()
              )
                return [{ type: "absent" }, current]
              return [
                {
                  type: "retire",
                  generation: slot.generation,
                  close: slot.close,
                  done: slot.done,
                  leader: slot.leader,
                },
                {
                  ...current,
                  slot: {
                    ...slot,
                    phase: "retiring",
                    departingLeases: slot.leases,
                    leases: new Map<string, number>(),
                    close: undefined,
                  },
                },
              ]
            },
          )
          const canceled =
            requireLease === undefined
              ? []
              : yield* cancelConnection(requireLease)
          if (action.type === "absent") {
            yield* joinAttempts(canceled)
            return false
          }
          if (action.type === "wait") {
            yield* Deferred.await(action.done)
            yield* joinAttempts(canceled)
            return action.authorized
          } else yield* finishRetirement(action, reason)
          yield* joinAttempts(canceled)
          return true
        }),
      )

    const acceptDraft = (
      generation: number,
      source: ResolvedCaptureSource,
      draft: AudioFeatureDraft,
      nowMs: number,
    ) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (
          current.closed ||
          current.slot.phase !== "active" ||
          current.slot.generation !== generation
        )
          return
        const previousTimestamp = yield* Ref.get(lastTimestamp)
        if (draft.timestampMs < previousTimestamp) return
        const sequence = (yield* Ref.get(sequences)) + 1
        const candidate = {
          daemonInstanceId: options.daemonInstanceId,
          generation,
          sequence,
          timestampMs: draft.timestampMs,
          publishedAtMs: nowMs,
          clockDomain: draft.clockDomain,
          sampleAgeMs: draft.sampleAgeMs,
          source: source.identity,
          capabilities: source.capabilities,
          spectrum: [...draft.spectrum],
          ...(draft.envelope === undefined
            ? {}
            : { envelope: draft.envelope.map((bucket) => ({ ...bucket })) }),
          ...(draft.channels === undefined
            ? {}
            : {
                channels: {
                  layout: draft.channels.layout,
                  rms: [...draft.channels.rms],
                  peaks: [...draft.channels.peaks],
                },
              }),
        }
        if (
          Buffer.byteLength(JSON.stringify(candidate), "utf8") >
          MAX_AUDIO_FEATURE_FRAME_BYTES
        )
          return
        const decoded = Schema.decodeUnknownResult(AudioFeatureFrame)(candidate)
        if (Result.isFailure(decoded)) return
        yield* Ref.set(sequences, sequence)
        yield* Ref.set(lastTimestamp, draft.timestampMs)
        yield* Ref.set(lastEmitAt, nowMs)
        yield* publishFrame(decoded.success)
      })

    const pendingSlot = yield* Ref.make<
      | {
          readonly generation: number
          readonly source: ResolvedCaptureSource
          readonly draft: AudioFeatureDraft
          readonly acceptedAtMs: number
          readonly dueMs: number
        }
      | undefined
    >(undefined)
    const cadenceWake = yield* Queue.sliding<void>(1)
    yield* Effect.forkIn(ownerScope, { startImmediately: true })(
      Effect.forever(
        Effect.gen(function* () {
          const pending = yield* Ref.get(pendingSlot)
          if (pending === undefined) {
            yield* Queue.take(cadenceWake)
            return
          }
          const now = nowMs()
          if (now < pending.dueMs) {
            yield* Effect.sleep(pending.dueMs - now)
            return
          }
          const taken = yield* Ref.modify(pendingSlot, (current) =>
            current === undefined || current.generation !== pending.generation
              ? ([undefined, current] as const)
              : ([current, undefined] as const),
          )
          if (taken === undefined) return
          const age = Math.max(0, now - taken.acceptedAtMs)
          yield* acceptDraft(
            taken.generation,
            taken.source,
            {
              ...taken.draft,
              sampleAgeMs: taken.draft.sampleAgeMs + age,
            },
            now,
          )
        }),
      ),
    )
    const considerFrame = (
      generation: number,
      source: ResolvedCaptureSource,
      draft: AudioFeatureDraft,
    ) =>
      Effect.gen(function* () {
        const now = nowMs()
        const emittedAt = yield* Ref.get(lastEmitAt)
        if (emittedAt >= 0 && now - emittedAt < AUDIO_FEATURE_INTERVAL_MS) {
          yield* Ref.set(pendingSlot, {
            generation,
            source,
            draft,
            acceptedAtMs: now,
            dueMs: emittedAt + AUDIO_FEATURE_INTERVAL_MS,
          })
          Queue.offerUnsafe(cadenceWake, undefined)
          return
        }
        yield* Ref.set(pendingSlot, undefined)
        yield* acceptDraft(generation, source, draft, now)
      })

    const runLeader = (
      generation: number,
      source: ResolvedCaptureSource,
      outcome: Deferred.Deferred<AudioStartResult>,
      ready: Deferred.Deferred<void>,
    ) => {
      let closeAdapter: Effect.Effect<void> = Effect.void
      return Effect.gen(function* () {
        yield* Deferred.await(ready)
        if ((yield* Ref.get(state)).closed) {
          yield* Deferred.succeed(outcome, canceledResult)
          return
        }
        const adapterScope = yield* Scope.make()
        // Every caller joins the same release, including its failure result.
        closeAdapter = yield* Effect.cached(
          Effect.uninterruptible(
            Scope.close(adapterScope, Exit.void).pipe(
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  if (Exit.isSuccess(exit)) return
                  const current = yield* Ref.updateAndGet(
                    state,
                    (current): CaptureState =>
                      current.slot.phase !== "idle" &&
                      current.slot.generation === generation
                        ? {
                            ...current,
                            slot: {
                              ...current.slot,
                              phase: "retiring",
                              departingLeases:
                                current.slot.departingLeases ??
                                current.slot.leases,
                              leases: new Map<string, number>(),
                            },
                          }
                        : current,
                  )
                  // Failed cleanup stays fenced, but every waiter must settle.
                  if (
                    current.slot.phase !== "idle" &&
                    current.slot.generation === generation
                  )
                    yield* Deferred.failCause(current.slot.done, exit.cause)
                  yield* Deferred.failCause(outcome, exit.cause)
                  yield* publishStatus({
                    type: "failed",
                    generation,
                    reason: "setup",
                  })
                }),
              ),
            ),
          ),
        )
        const stillAdmitted = yield* Ref.modify(state, (current) => {
          if (
            current.closed ||
            current.slot.phase !== "acquiring" ||
            current.slot.generation !== generation ||
            current.slot.leases.size === 0
          )
            return [false, current] as const
          return [
            true,
            { ...current, slot: { ...current.slot, close: closeAdapter } },
          ] as const
        })
        if (!stillAdmitted) {
          yield* closeAdapter
          yield* Deferred.succeed(outcome, canceledResult)
          return
        }
        yield* publishStatus({ type: "acquiring", generation })
        const started = yield* Effect.suspend(() =>
          Scope.provide(adapterScope)(options.adapter.start(source)),
        ).pipe(Effect.exit)
        if (Exit.isFailure(started)) {
          if (Cause.hasInterruptsOnly(started.cause))
            return yield* Effect.interrupt
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const ownsRetirement = yield* Ref.modify(state, (current) => {
                if (
                  current.slot.phase !== "acquiring" ||
                  current.slot.generation !== generation
                )
                  return [false, current] as const
                return [
                  true,
                  {
                    ...current,
                    slot: {
                      ...current.slot,
                      phase: "retiring" as const,
                      departingLeases: current.slot.leases,
                      leases: new Map<string, number>(),
                      close: undefined,
                    },
                  },
                ] as const
              })
              yield* closeAdapter
              if (!ownsRetirement) return
              const reason = adapterFailureReason(started.cause)
              yield* releaseRetiring(generation, { failed: reason })
              yield* Deferred.succeed(outcome, { type: "failed", reason })
            }),
          )
          return
        }
        const decision = yield* Effect.uninterruptible(
          Ref.modify(
            state,
            (
              current,
            ): readonly [
              { readonly publish: boolean; readonly ownsRetirement?: boolean },
              CaptureState,
            ] => {
              if (
                current.closed ||
                current.slot.phase !== "acquiring" ||
                current.slot.generation !== generation ||
                current.slot.leases.size === 0
              )
                return [{ publish: false }, current]
              const now = nowMs()
              if (
                ![...current.slot.leases.values()].some(
                  (deadline) => deadline > now,
                )
              )
                return [
                  { publish: false, ownsRetirement: true },
                  {
                    ...current,
                    slot: {
                      ...current.slot,
                      phase: "retiring",
                      departingLeases: current.slot.leases,
                      leases: new Map(),
                      close: undefined,
                    },
                  },
                ]
              return [
                { publish: true },
                {
                  ...current,
                  slot: {
                    ...current.slot,
                    phase: "active",
                    leases: new Map(
                      [...current.slot.leases].map(([id, deadline]) => [
                        id,
                        deadline > now ? now + interestLeaseMs : deadline,
                      ]),
                    ),
                  },
                },
              ]
            },
          ),
        )
        if (!decision.publish) {
          yield* closeAdapter
          if (decision.ownsRetirement)
            yield* releaseRetiring(generation, "lease-expired")
          yield* Deferred.succeed(outcome, canceledResult)
          return
        }
        yield* publishStatus({
          type: "active",
          generation,
          source: source.identity,
          capabilities: source.capabilities,
        })
        yield* Deferred.succeed(outcome, {
          type: "started",
          generation,
          source: source.identity,
        })
        yield* Effect.forkIn(adapterScope, { startImmediately: true })(
          started.value.frames.pipe(
            Stream.runForEach((draft) =>
              considerFrame(generation, source, draft),
            ),
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                ? Effect.failCause(exit.cause)
                : retire(
                    generation,
                    Exit.isFailure(exit)
                      ? { failed: adapterFailureReason(exit.cause) }
                      : "source-loss",
                  ).pipe(
                    // Retirement must not close and join its own stream fiber.
                    Effect.forkIn(ownerScope),
                    Effect.asVoid,
                  ),
            ),
          ),
        )
      }).pipe(
        Effect.ensuring(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const current = yield* Ref.get(state)
              if (
                current.slot.generation === generation &&
                current.slot.phase === "active"
              )
                return
              yield* closeAdapter
              // The retirement owner completes done after joining this leader.
              yield* Deferred.succeed(outcome, canceledResult)
            }),
          ),
        ),
      )
    }

    const observe = (observation: ProviderSourceObservation) =>
      Effect.gen(function* () {
        const current = yield* Ref.updateAndGet(state, (latest) =>
          (latest.latestObservation?.sequence ?? -Infinity) >=
          observation.sequence
            ? latest
            : { ...latest, latestObservation: observation },
        )
        const slot = current.slot
        if (slot.phase !== "active" && slot.phase !== "acquiring") return
        if (observation.sequence <= slot.source.observationSequence) return
        if (
          slot.source.mode === "now-playing" &&
          observation.kind !== "snapshot"
        ) {
          yield* retire(slot.generation, "source-loss")
          return
        }
        const verdict = yield* options.resolver.confirm(
          slot.source,
          observation,
        )
        const after = yield* Ref.get(state)
        if (
          after.slot.phase === "idle" ||
          after.slot.generation !== slot.generation
        )
          return
        if (verdict === "same") {
          yield* Ref.update(state, (latest) =>
            latest.slot.phase !== "idle" &&
            latest.slot.generation === slot.generation
              ? {
                  ...latest,
                  slot: {
                    ...latest.slot,
                    source: {
                      ...latest.slot.source,
                      observationSequence: observation.sequence,
                    },
                  },
                }
              : latest,
          )
          return
        }
        yield* retire(slot.generation, "source-loss")
      })

    // Drain provider callbacks independently of resolver confirmation. Neither
    // native retirement nor authority revocation may wait for a blocked confirm.
    const observationQueue =
      yield* Queue.dropping<ProviderSourceObservation>(16)
    let observer: Fiber.Fiber<void> | undefined
    const closeObservations = (interruptObserver: boolean) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { slot } = yield* Ref.updateAndGet(state, (current) => ({
            ...current,
            observationsClosed: true,
          }))
          if (interruptObserver) observer?.interruptUnsafe()
          if (slot.phase === "active" || slot.phase === "acquiring")
            yield* retire(slot.generation, "source-loss")
          else if (slot.phase === "retiring") yield* Deferred.await(slot.done)
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              interruptObserver && observer
                ? Fiber.interrupt(observer)
                : Effect.void,
            ),
          ),
        ),
      )
    observer = yield* Effect.forkIn(ownerScope, { startImmediately: true })(
      Stream.fromQueue(observationQueue).pipe(
        Stream.runForEach(observe),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : closeObservations(false),
        ),
      ),
    )
    yield* Effect.forkIn(ownerScope, { startImmediately: true })(
      options.observations.pipe(
        Stream.runForEach((observation) =>
          Ref.update(state, (current) =>
            (current.latestObservation?.sequence ?? -Infinity) >=
            observation.sequence
              ? current
              : { ...current, latestObservation: observation },
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (!Queue.offerUnsafe(observationQueue, observation))
                  throw new Error("capture source observation overflow")
              }),
            ),
          ),
        ),
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
            ? Effect.failCause(exit.cause)
            : closeObservations(true),
        ),
      ),
    )

    yield* Effect.addFinalizer(() =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const pending = yield* Ref.modify(state, (current) => [
            [...current.attempts.values()],
            {
              ...current,
              closed: true,
              attempts: new Map(),
              tokens: new Map(),
            },
          ])
          for (const attempt of pending)
            yield* Deferred.succeed(attempt.cancel, undefined)
          const slot = (yield* Ref.get(state)).slot
          if (slot.phase === "retiring") {
            if (slot.close) yield* slot.close
            yield* Deferred.await(slot.done)
          } else if (slot.phase === "acquiring" || slot.phase === "active")
            yield* retire(slot.generation, "canceled")
        }),
      ),
    )

    const pruneTokens = (
      tokens: ReadonlyMap<string, IssuedToken>,
      now: number,
    ) => {
      const next = new Map<string, IssuedToken>()
      for (const [key, token] of tokens)
        if (token.expiresAtMs >= now) next.set(key, token)
      return next
    }

    const listSources = Effect.fn("AudioCapture.listSources")(function* (
      connectionId: string,
    ) {
      yield* expireInterests(false)
      if ((yield* Ref.get(state)).closed) return unavailableAudioSourceList()
      if (options.adapter.availability === "unavailable")
        return unavailableAudioSourceList()
      const catalog = yield* options.resolver.list()
      if (catalog.availability === "unavailable")
        return unavailableAudioSourceList(
          catalog.reason ?? "capture-adapter-unavailable",
        )
      const now = yield* Clock.currentTimeMillis
      const sources: Array<AudioSourceList["sources"][number]> = []
      const issued: IssuedToken[] = []
      for (const source of catalog.sources) {
        if (sources.length >= MAX_AUDIO_SOURCES) break
        if (!selectionMatchesIdentity(source)) continue
        const token = `sel_${randomUUID()}`
        sources.push({
          label: source.label,
          mode: source.mode,
          token,
          capabilities: source.capabilities,
        })
        issued.push({
          token,
          connectionId,
          daemonInstanceId: options.daemonInstanceId,
          expiresAtMs: now + ttl,
          source,
        })
      }
      yield* Ref.update(state, (current) => {
        const tokens = pruneTokens(current.tokens, now)
        const owned = [...tokens.values()].filter(
          (token) => token.connectionId === connectionId,
        )
        while (
          owned.length + issued.length > MAX_AUDIO_SELECTIONS_PER_CONNECTION &&
          owned.length > 0
        ) {
          const oldest = owned.shift()
          if (oldest) tokens.delete(oldest.token)
        }
        for (const token of issued) tokens.set(token.token, token)
        return { ...current, tokens }
      })
      return sources.length === 0
        ? unavailableAudioSourceList()
        : { availability: "available" as const, sources }
    })

    const cancelConnection = (connectionId: string) =>
      Ref.get(state).pipe(
        Effect.map((current) =>
          [...current.attempts.values()].filter(
            (attempt) => attempt.connectionId === connectionId,
          ),
        ),
        Effect.flatMap((attempts) =>
          Effect.forEach(
            attempts,
            (attempt) => Deferred.succeed(attempt.cancel, undefined),
            { discard: true },
          ).pipe(Effect.as(attempts)),
        ),
      )

    const joinAttempts = (attempts: readonly Attempt[]) =>
      Effect.forEach(attempts, (attempt) => Deferred.await(attempt.done), {
        discard: true,
      })

    const prepare = (
      connectionId: string,
      token: string,
      cancel: Deferred.Deferred<void>,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const current = yield* Ref.get(state)
        if (current.closed || Deferred.isDoneUnsafe(cancel))
          return { type: "result" as const, result: canceledResult }
        const issued = current.tokens.get(token)
        if (!issued)
          return {
            type: "result" as const,
            result: {
              type: "rejected" as const,
              reason: "unknown-token" as const,
            },
          }
        if (issued.daemonInstanceId !== options.daemonInstanceId)
          return {
            type: "result" as const,
            result: {
              type: "rejected" as const,
              reason: "wrong-daemon" as const,
            },
          }
        if (issued.connectionId !== connectionId)
          return {
            type: "result" as const,
            result: {
              type: "rejected" as const,
              reason: "wrong-connection" as const,
            },
          }
        if (now > issued.expiresAtMs)
          return {
            type: "result" as const,
            result: {
              type: "rejected" as const,
              reason: "expired-token" as const,
            },
          }
        if (!selectionMatchesIdentity(issued.source))
          return {
            type: "result" as const,
            result: {
              type: "rejected" as const,
              reason: "invalid-selection" as const,
            },
          }
        if (options.adapter.availability === "unavailable")
          return {
            type: "result" as const,
            result: {
              type: "unavailable" as const,
              reason: "capture-adapter-unavailable" as const,
            },
          }
        const resolved = yield* options.resolver.revalidate(issued.source)
        const after = yield* Clock.currentTimeMillis
        if (
          (yield* Ref.get(state)).closed ||
          Deferred.isDoneUnsafe(cancel) ||
          after > issued.expiresAtMs
        )
          return {
            type: "result" as const,
            result:
              Deferred.isDoneUnsafe(cancel) || (yield* Ref.get(state)).closed
                ? canceledResult
                : {
                    type: "rejected" as const,
                    reason: "expired-token" as const,
                  },
          }
        if (!resolved || !selectionMatchesIdentity(resolved))
          return {
            type: "result" as const,
            result: {
              type: "rejected" as const,
              reason: "unresolved-source" as const,
            },
          }
        if (isPidReuse(issued.source.identity, resolved.identity))
          return {
            type: "result" as const,
            result: { type: "rejected" as const, reason: "pid-reuse" as const },
          }
        if (!sameCaptureIdentity(issued.source.identity, resolved.identity))
          return {
            type: "result" as const,
            result: {
              type: "rejected" as const,
              reason: "stale-identity" as const,
            },
          }
        const observation = (yield* Ref.get(state)).latestObservation
        if (
          observation &&
          observation.sequence > resolved.observationSequence &&
          (resolved.mode === "now-playing" || observation.kind !== "snapshot")
        ) {
          const verdict = yield* options.resolver.confirm(resolved, observation)
          if (Deferred.isDoneUnsafe(cancel) || (yield* Ref.get(state)).closed)
            return { type: "result" as const, result: canceledResult }
          if (verdict !== "same")
            return {
              type: "result" as const,
              result: {
                type: "rejected" as const,
                reason: "unresolved-source" as const,
              },
            }
        }
        return {
          type: "ready" as const,
          source: {
            ...resolved,
            observationSequence: Math.max(
              issued.source.observationSequence,
              resolved.observationSequence,
              observation?.sequence ?? 0,
            ),
          },
        }
      })

    const claim = (
      connectionId: string,
      source: ResolvedCaptureSource,
      token: string,
      cancel: Deferred.Deferred<void>,
      attemptId: number,
    ) =>
      Clock.clockWith((clock) =>
        Ref.modify(state, (current): readonly [Claim, CaptureState] => {
          if (current.closed || Deferred.isDoneUnsafe(cancel))
            return [{ type: "canceled" }, current]
          if (current.observationsClosed)
            return [{ type: "unresolved-source" }, current]
          if (
            current.latestObservation &&
            current.latestObservation.sequence > source.observationSequence
          )
            return [{ type: "retry" }, current]
          const issued = current.tokens.get(token)
          if (!issued) return [{ type: "unknown-token" }, current]
          if (clock.currentTimeMillisUnsafe() > issued.expiresAtMs)
            return [{ type: "expired-token" }, current]
          const consume = () => {
            const tokens = new Map(current.tokens)
            tokens.delete(token)
            return tokens
          }
          const slot = current.slot
          if (slot.phase === "retiring")
            return [{ type: "wait", done: slot.done }, current]
          if (
            (slot.phase === "active" || slot.phase === "acquiring") &&
            ![...slot.leases.values()].some((deadline) => deadline > nowMs())
          )
            return [{ type: "expired-interest" }, current]
          if (slot.phase === "idle") {
            const generation = slot.generation + 1
            const outcome = Deferred.makeUnsafe<AudioStartResult>()
            const done = Deferred.makeUnsafe<void>()
            return [
              { type: "leader", generation, outcome, source },
              {
                ...current,
                tokens: consume(),
                slot: {
                  phase: "acquiring",
                  generation,
                  source,
                  leases: new Map([
                    [connectionId, nowMs() + startupInterestMs],
                  ]),
                  interestOwners: new Map([
                    [connectionId, new Set([attemptId])],
                  ]),
                  outcome,
                  done,
                  close: undefined,
                  leader: undefined,
                },
              },
            ]
          }
          if (sameSelection(slot.source, source)) {
            const leases = new Map(slot.leases)
            const interestOwners = new Map(slot.interestOwners)
            interestOwners.set(
              connectionId,
              new Set([...(interestOwners.get(connectionId) ?? []), attemptId]),
            )
            leases.set(
              connectionId,
              nowMs() +
                (slot.phase === "acquiring"
                  ? startupInterestMs
                  : interestLeaseMs),
            )
            if (slot.phase === "acquiring")
              return [
                {
                  type: "waiter",
                  generation: slot.generation,
                  outcome: slot.outcome,
                },
                {
                  ...current,
                  tokens: consume(),
                  slot: { ...slot, leases, interestOwners },
                },
              ]
            if (slot.phase === "active")
              return [
                {
                  type: "joined",
                  generation: slot.generation,
                  source: slot.source.identity,
                },
                {
                  ...current,
                  tokens: consume(),
                  slot: { ...slot, leases, interestOwners },
                },
              ]
          }
          return [{ type: "busy" }, current]
        }),
      )

    const start = Effect.fn("AudioCapture.start")(function* (
      connectionId: string,
      token: string,
    ) {
      const attemptId = ++nextAttempt
      const cancel = Deferred.makeUnsafe<void>()
      const done = Deferred.makeUnsafe<void>()
      let admittedGeneration: number | undefined
      let waitingRetirement: Deferred.Deferred<void> | undefined
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(state)).closed) return canceledResult
          yield* Ref.update(state, (current) => {
            const attempts = new Map(current.attempts)
            attempts.set(attemptId, {
              id: attemptId,
              connectionId,
              cancel,
              done,
            })
            return { ...current, attempts }
          })
          return yield* Effect.gen(function* () {
            // Cancellation owns the attempt before any blocked retirement wait.
            // New admission still cannot revive a generation whose interest expired.
            yield* expireInterests(true)
            for (;;) {
              if (
                (yield* Ref.get(state)).closed ||
                Deferred.isDoneUnsafe(cancel)
              )
                return canceledResult
              const prepared = yield* restore(
                Effect.raceFirst(
                  prepare(connectionId, token, cancel),
                  Deferred.await(cancel).pipe(
                    Effect.as({
                      type: "result" as const,
                      result: canceledResult,
                    }),
                  ),
                ),
              )
              if (prepared.type === "result") return prepared.result
              const admitted = yield* claim(
                connectionId,
                prepared.source,
                token,
                cancel,
                attemptId,
              )
              if (admitted.type === "canceled") return canceledResult
              if (admitted.type === "retry") continue
              if (admitted.type === "expired-interest") {
                yield* expireInterests(true)
                continue
              }
              if (
                admitted.type === "unknown-token" ||
                admitted.type === "expired-token" ||
                admitted.type === "unresolved-source"
              )
                return {
                  type: "rejected" as const,
                  reason: admitted.type,
                }
              if (admitted.type === "busy") return { type: "busy" as const }
              if (
                admitted.type === "joined" ||
                admitted.type === "waiter" ||
                admitted.type === "leader"
              )
                admittedGeneration = admitted.generation
              if (admitted.type === "joined")
                return {
                  type: "joined" as const,
                  generation: admitted.generation,
                  source: admitted.source,
                }
              if (admitted.type === "wait") {
                waitingRetirement = admitted.done
                const winner = yield* restore(
                  Effect.raceFirst(
                    Deferred.await(admitted.done).pipe(
                      Effect.as("retired" as const),
                    ),
                    Deferred.await(cancel).pipe(Effect.as("detached" as const)),
                  ),
                )
                if (winner === "detached") {
                  yield* Deferred.await(admitted.done)
                  return canceledResult
                }
                waitingRetirement = undefined
                continue
              }
              if (admitted.type === "waiter")
                return yield* restore(
                  Effect.raceFirst(
                    Deferred.await(admitted.outcome),
                    Deferred.await(cancel).pipe(Effect.as(canceledResult)),
                  ),
                )
              const ready = Deferred.makeUnsafe<void>()
              const fiber = yield* Effect.forkIn(ownerScope, {
                startImmediately: true,
              })(
                Effect.interruptible(
                  runLeader(
                    admitted.generation,
                    admitted.source,
                    admitted.outcome,
                    ready,
                  ),
                ),
              )
              yield* Ref.update(state, (current) =>
                current.slot.phase !== "idle" &&
                current.slot.generation === admitted.generation
                  ? { ...current, slot: { ...current.slot, leader: fiber } }
                  : current,
              )
              yield* Deferred.succeed(ready, undefined)
              return yield* restore(
                Effect.raceFirst(
                  Deferred.await(admitted.outcome),
                  Deferred.await(cancel).pipe(Effect.as(canceledResult)),
                ),
              )
            }
          }).pipe(
            Effect.flatMap((result): Effect.Effect<AudioStartResult> =>
              result.type === "started" || result.type === "joined"
                ? Ref.modify(
                    state,
                    (current): readonly [AudioStartResult, CaptureState] => {
                      if (
                        Deferred.isDoneUnsafe(cancel) ||
                        !joined(current, connectionId, result.generation) ||
                        current.slot.phase === "idle" ||
                        !current.slot.interestOwners
                          .get(connectionId)
                          ?.has(attemptId)
                      )
                        return [canceledResult, current] as const
                      return [result, current] as const
                    },
                  )
                : Effect.succeed(result),
            ),
          )
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            // This finalizer is outside the whole admission mask. A pending caller
            // interruption must be observed before an attempt becomes durable.
            const finalized = yield* Effect.gen(function* () {
              if (waitingRetirement !== undefined)
                yield* Deferred.await(waitingRetirement)
              if (admittedGeneration === undefined) return
              if (
                Exit.isSuccess(exit) &&
                (exit.value.type === "started" || exit.value.type === "joined")
              ) {
                yield* Ref.update(state, (current) => {
                  const slot = current.slot
                  if (
                    Deferred.isDoneUnsafe(cancel) ||
                    slot.phase === "idle" ||
                    slot.generation !== admittedGeneration ||
                    !slot.interestOwners.get(connectionId)?.has(attemptId)
                  )
                    return current
                  const interestOwners = new Map(slot.interestOwners)
                  const owners = new Set(interestOwners.get(connectionId))
                  owners.delete(attemptId)
                  // Completed Starts share one durable owner; pending Starts do not.
                  owners.add(0)
                  interestOwners.set(connectionId, owners)
                  return { ...current, slot: { ...slot, interestOwners } }
                })
              } else
                yield* leaveInterest(
                  connectionId,
                  "canceled",
                  admittedGeneration,
                  attemptId,
                )
            }).pipe(Effect.exit)
            yield* Ref.update(state, (current) => {
              const attempts = new Map(current.attempts)
              attempts.delete(attemptId)
              return { ...current, attempts }
            })
            const completion = Exit.isFailure(finalized)
              ? finalized
              : Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                ? Exit.failCause(exit.cause)
                : Exit.void
            yield* Deferred.done(done, completion)
            if (Exit.isFailure(finalized))
              yield* Effect.failCause(finalized.cause)
          }),
        ),
      )
    })

    const stop = Effect.fn("AudioCapture.stop")(function* (
      connectionId: string,
    ) {
      const current = yield* Ref.get(state)
      if (
        current.slot.phase === "idle" ||
        !(
          joined(current, connectionId, current.slot.generation) ||
          (current.slot.phase === "retiring" &&
            current.slot.interestOwners.has(connectionId))
        )
      ) {
        yield* joinAttempts(yield* cancelConnection(connectionId))
        return { type: "rejected" as const, reason: "not-joined" as const }
      }
      const generation = current.slot.generation
      const retired = yield* retire(generation, "stop", connectionId)
      if (!retired)
        return { type: "rejected" as const, reason: "not-joined" as const }
      return { type: "stopped" as const, generation, reason: "stop" as const }
    }, Effect.uninterruptible)

    const removeInterest = (
      current: CaptureState,
      connectionId: string,
      generation?: number,
      attemptId?: number,
    ): readonly [LeaveAction, CaptureState] => {
      const slot = current.slot
      if (
        slot.phase === "idle" ||
        (generation !== undefined && slot.generation !== generation) ||
        !slot.interestOwners.has(connectionId) ||
        (attemptId !== undefined &&
          !slot.interestOwners.get(connectionId)?.has(attemptId))
      )
        return [{ type: "none" }, current]
      if (slot.phase === "retiring")
        return [{ type: "wait", done: slot.done }, current]
      const interestOwners = new Map(slot.interestOwners)
      if (attemptId !== undefined) {
        const owners = new Set(interestOwners.get(connectionId))
        owners.delete(attemptId)
        if (owners.size > 0) {
          interestOwners.set(connectionId, owners)
          return [
            { type: "remain" },
            { ...current, slot: { ...slot, interestOwners } },
          ]
        }
      }
      const leases = new Map(slot.leases)
      leases.delete(connectionId)
      interestOwners.delete(connectionId)
      if ([...leases.values()].some((deadline) => deadline > nowMs()))
        return [
          { type: "remain" },
          { ...current, slot: { ...slot, leases, interestOwners } },
        ]
      return [
        {
          type: "last",
          generation: slot.generation,
          close: slot.close,
          done: slot.done,
          leader: slot.leader,
        },
        {
          ...current,
          slot: {
            ...slot,
            phase: "retiring",
            departingLeases: slot.leases,
            leases: new Map<string, number>(),
            close: undefined,
          },
        },
      ]
    }

    const leaveInterest = Effect.fn("AudioCapture.leaveInterest")(function* (
      connectionId: string,
      reason: StopReason,
      generation: number,
      attemptId: number,
    ) {
      const action = yield* Ref.modify(state, (current) =>
        removeInterest(current, connectionId, generation, attemptId),
      )
      if (action.type === "wait") yield* Deferred.await(action.done)
      if (action.type === "last") {
        yield* finishRetirement({ ...action, type: "retire" }, reason)
      }
    }, Effect.uninterruptible)

    const beginDetach = Effect.fn("AudioCapture.beginDetach")(function* (
      connectionId: string,
    ) {
      const { action, canceled } = yield* Ref.modify(state, (current) => {
        const tokens = new Map(current.tokens)
        for (const [key, token] of tokens)
          if (token.connectionId === connectionId) tokens.delete(key)
        const canceled = [...current.attempts.values()].filter(
          (attempt) => attempt.connectionId === connectionId,
        )
        const [action, next] = removeInterest(
          { ...current, tokens },
          connectionId,
        )
        return [{ action, canceled }, next] as const
      })
      yield* Effect.forEach(
        canceled,
        (attempt) => Deferred.succeed(attempt.cancel, undefined),
        { discard: true },
      )
      let retirement: Effect.Effect<void> = Effect.void
      if (action.type === "last") {
        // The outer effect starts exactly one owner-scoped retirement. Closing
        // the subscriber cannot abandon it, even if completion is never run.
        const worker = yield* finishRetirement(
          { ...action, type: "retire" },
          "last-connection",
        ).pipe(Effect.forkIn(ownerScope, { startImmediately: true }))
        retirement = Fiber.join(worker)
      } else if (action.type === "wait")
        retirement = Deferred.await(action.done)
      return yield* Effect.cached(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const exits = yield* Effect.forEach(
              [
                retirement,
                ...canceled.map((attempt) => Deferred.await(attempt.done)),
              ],
              Effect.exit,
            )
            for (const exit of exits)
              if (Exit.isFailure(exit)) yield* Effect.failCause(exit.cause)
          }),
        ),
      )
    }, Effect.uninterruptible)

    const detach = Effect.fn("AudioCapture.detach")(function* (
      connectionId: string,
    ) {
      yield* yield* beginDetach(connectionId)
    }, Effect.uninterruptible)

    const expireInterests = Effect.fn("AudioCapture.expireInterests")(
      function* (joinRetirement: boolean) {
        const action = yield* Ref.modify(
          state,
          (current): readonly [ExpireAction | undefined, CaptureState] => {
            const slot = current.slot
            if (slot.phase !== "active" && slot.phase !== "acquiring")
              return [undefined, current]
            const expired = new Set(
              [...slot.leases]
                .filter(([, deadline]) => deadline <= nowMs())
                .map(([id]) => id),
            )
            if (expired.size === 0) return [undefined, current]
            const leases = new Map(slot.leases)
            for (const id of expired) leases.delete(id)
            const interestOwners = new Map(slot.interestOwners)
            for (const id of expired) interestOwners.delete(id)
            const attempts = new Map(current.attempts)
            const canceled: Attempt[] = []
            for (const attempt of attempts.values()) {
              if (!expired.has(attempt.connectionId)) continue
              canceled.push(attempt)
            }
            const tokens = new Map(current.tokens)
            for (const [token, issued] of tokens)
              if (expired.has(issued.connectionId)) tokens.delete(token)
            const last = leases.size === 0
            return [
              {
                generation: slot.generation,
                expired,
                canceled,
                retiring: last ? slot : undefined,
              },
              {
                ...current,
                attempts,
                tokens,
                slot: {
                  ...slot,
                  leases,
                  interestOwners: last ? slot.interestOwners : interestOwners,
                  ...(last
                    ? {
                        phase: "retiring",
                        departingLeases: slot.leases,
                        close: undefined,
                      }
                    : {}),
                },
              },
            ]
          },
        )
        if (!action) return
        yield* Effect.forEach(
          action.canceled,
          (attempt) => Deferred.succeed(attempt.cancel, undefined),
          { discard: true },
        )
        if (action.retiring) {
          const retirement = finishRetirement(
            { ...action.retiring, type: "retire" },
            "lease-expired",
          )
          if (joinRetirement) yield* retirement
          else
            yield* retirement.pipe(
              Effect.forkIn(ownerScope, { startImmediately: true }),
            )
        } else {
          const sinks = yield* Ref.get(statusSinks)
          yield* Effect.forEach(
            [...sinks.values()].filter((sink) =>
              action.expired.has(sink.connectionId),
            ),
            (sink) =>
              Effect.sync(() =>
                sink.offer({
                  type: "stopped",
                  generation: action.generation,
                  reason: "lease-expired",
                }),
              ),
            { discard: true },
          )
        }
      },
      Effect.uninterruptible,
    )

    const renew = Effect.fn("AudioCapture.renew")(function* (
      connectionId: string,
      generation: number,
    ) {
      return yield* Ref.modify(
        state,
        (current): readonly [AudioRenewResult, CaptureState] => {
          if (
            current.closed ||
            current.slot.phase !== "active" ||
            !joined(current, connectionId, generation)
          )
            return [{ type: "rejected", reason: "not-joined" }, current]
          const leases = new Map(current.slot.leases)
          leases.set(connectionId, nowMs() + interestLeaseMs)
          return [
            { type: "renewed", generation },
            { ...current, slot: { ...current.slot, leases } },
          ]
        },
      )
    })

    yield* expireInterests(true).pipe(
      Effect.repeat(Schedule.spaced(AUDIO_INTEREST_SWEEP_MS)),
      Effect.forkIn(ownerScope),
    )

    const subscribeStatus = (connectionId: string) =>
      Stream.callback<AudioCaptureStatus>(
        (queue) =>
          Effect.gen(function* () {
            const sinkId = ++nextSink
            Queue.offerUnsafe(queue, yield* Ref.get(status))
            yield* Ref.update(statusSinks, (sinks) => {
              const next = new Map(sinks)
              next.set(sinkId, {
                connectionId,
                offer: (nextStatus) => {
                  // Status carries authority evidence. End an overloaded
                  // subscription instead of silently replacing lease expiry.
                  if (!Queue.offerUnsafe(queue, nextStatus))
                    Queue.endUnsafe(queue)
                },
              })
              return next
            })
            yield* Effect.addFinalizer(() =>
              Ref.update(statusSinks, (sinks) => {
                const next = new Map(sinks)
                next.delete(sinkId)
                return next
              }),
            )
          }),
        { bufferSize: 16, strategy: "dropping" },
      )

    const subscribeFeatures = (
      connectionId: string,
      subscriptionOptions?: { readonly detachOnClose?: boolean },
    ) =>
      Stream.callback<AudioFeatureFrameValue>(
        (queue) =>
          Effect.gen(function* () {
            const sinkId = ++nextSink
            const subscribedEpoch = yield* Ref.get(featureEpoch)
            const current = yield* Ref.get(state)
            const frame = yield* Ref.get(latestFrame)
            if (frame && joined(current, connectionId, frame.generation))
              Queue.offerUnsafe(queue, frame)
            yield* Ref.update(featureSinks, (sinks) => {
              const next = new Map(sinks)
              next.set(sinkId, {
                connectionId,
                epoch: subscribedEpoch,
                offer: (nextFrame) => {
                  Queue.offerUnsafe(queue, nextFrame)
                },
              })
              return next
            })
            yield* Effect.addFinalizer(() =>
              Ref.modify(featureSinks, (sinks) => {
                const next = new Map(sinks)
                next.delete(sinkId)
                const remaining = [...next.values()].filter(
                  (sink) => sink.connectionId === connectionId,
                ).length
                return [remaining, next] as const
              }).pipe(
                Effect.flatMap((remaining) =>
                  remaining === 0 &&
                  subscriptionOptions?.detachOnClose !== false
                    ? detach(connectionId)
                    : Effect.void,
                ),
              ),
            )
          }),
        { bufferSize: 1, strategy: "sliding" },
      ).pipe(
        Stream.filterEffect((frame) =>
          Ref.get(state).pipe(
            Effect.map((current) =>
              joined(current, connectionId, frame.generation),
            ),
          ),
        ),
      )

    return AudioCapture.of({
      listSources,
      start,
      stop,
      renew,
      subscribeStatus,
      subscribeFeatures,
      beginDetach:
        options.adapter.availability === "unavailable"
          ? () => Effect.succeed(Effect.void)
          : beginDetach,
      detach,
      status: () => Ref.get(status),
    })
  })

export const layerFromAdapters = (options: AudioCaptureOptions) =>
  Layer.effect(AudioCapture, makeAudioCapture(options))

export const unavailableLayer = (
  daemonInstanceId: string,
  observations: Stream.Stream<ProviderSourceObservation> = unavailableSourceObservations,
) =>
  layerFromAdapters({
    daemonInstanceId,
    resolver: unavailableAudioSourceResolver,
    adapter: unavailableAudioCaptureAdapter,
    observations,
  })
