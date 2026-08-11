import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  createSystemMediaAdapter,
  hasMediaControl,
  hasNowPlayingCli,
  type SystemMediaAttemptAdapter,
} from "../system-media.ts"
import {
  emptyPlayer,
  type MusicChangeEvent,
  type PlayerState,
} from "../types.ts"
import type { ProviderStatus, TransportAction } from "./protocol.ts"

export class ProviderError extends Schema.TaggedErrorClass<ProviderError>()(
  "MusicSession.ProviderError",
  { operation: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

const providerError = (operation: string, cause: unknown) =>
  new ProviderError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause: { cause },
  })

/** Effect-owned provider boundary. No daemon code reaches the Node adapter directly. */
export class SessionProvider extends Context.Service<
  SessionProvider,
  {
    readonly status: () => Effect.Effect<ProviderStatus, ProviderError>
    readonly sample: () => Effect.Effect<PlayerState | null, ProviderError>
    readonly transport: (
      action: TransportAction,
      positionMs?: number,
    ) => Effect.Effect<void, ProviderError>
    readonly events: Stream.Stream<MusicChangeEvent, ProviderError>
  }
>()("@naxodev/music-core/SessionProvider") {}

const status = (): ProviderStatus => {
  if (hasMediaControl())
    return {
      kind: "ready",
      provider: "media-control",
      message: "media-control ready",
    }
  if (hasNowPlayingCli())
    return {
      kind: "degraded",
      provider: "nowplaying-cli",
      message: "media-control unavailable; using nowplaying-cli",
    }
  return {
    kind: "unavailable",
    provider: null,
    message: "install media-control or nowplaying-cli",
  }
}

const drainSnapshots = (
  snapshots: Queue.Dequeue<void>,
): Effect.Effect<boolean> =>
  Queue.poll(snapshots).pipe(
    Effect.flatMap((snapshot) =>
      Option.isSome(snapshot)
        ? drainSnapshots(snapshots).pipe(Effect.as(true))
        : Effect.succeed(false),
    ),
  )

export const attemptRetrySchedule = (
  retries: Ref.Ref<number>,
  successfulSnapshots: Queue.Dequeue<void>,
) =>
  Schedule.forever.pipe(
    // Drain every snapshot token from the just-completed attempt. A later
    // terminal with no snapshot must retain its own backoff progression.
    Schedule.addDelay(() =>
      drainSnapshots(successfulSnapshots).pipe(
        Effect.flatMap((receivedSnapshot) =>
          receivedSnapshot ? Ref.set(retries, 0) : Effect.void,
        ),
        Effect.flatMap(() =>
          Ref.modify(retries, (retry) => [
            Duration.seconds(Math.min(2 ** retry, 8)),
            Math.min(retry + 1, 3),
          ]),
        ),
      ),
    ),
  )

type AttemptResult = { readonly sawSnapshot: boolean }

/** Test-only observation hook for recovered provider failures. */
export type ProviderEventHooks = {
  readonly reportError?: (error: ProviderError) => void
}

/**
 * Converts one unsupervised callback attempt into bounded Effect-owned state.
 * Snapshots have their own conflating slot; terminal notifications have a
 * separate capacity-one signal and therefore cannot be slid out by snapshots.
 */
export const eventsFromAttemptAdapter = (
  backend: SystemMediaAttemptAdapter,
  hooks: ProviderEventHooks = {},
): Stream.Stream<MusicChangeEvent, ProviderError> => {
  if (!backend.subscribeAttempt) return Stream.never

  return Stream.callback(
    (output) =>
      Effect.gen(function* () {
        let closed = false
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true
          }),
        )

        const emit = (event: MusicChangeEvent) =>
          Queue.offer(output, event).pipe(
            // A consumer closing its stream is normal scope shutdown, not a
            // provider error. Interruption still unwinds the active source.
            Effect.catchCause(() => Effect.never),
          )

        const reportError = (error: ProviderError) =>
          // Recovery keeps the event stream live, but must not erase the
          // tagged failure from production diagnostics. Focused tests install
          // an observer instead of writing expected failures to test output.
          hooks.reportError
            ? Effect.sync(() => hooks.reportError?.(error))
            : Effect.logError(error)

        const runAttempt = (): Effect.Effect<
          AttemptResult,
          ProviderError,
          Scope.Scope
        > =>
          Effect.gen(function* () {
            // These queues are private to one attempt. Callback code only uses
            // offerUnsafe, so it never starts work or waits on a consumer.
            const snapshots = yield* Queue.sliding<MusicChangeEvent>(1)
            const terminals = yield* Queue.bounded<void>(1)
            let accepting = true
            let sawSnapshot = false

            const dispose = (source: () => void) =>
              Effect.try({
                try: source,
                catch: (cause) => providerError("dispose", cause),
              })

            const acquireSource = Effect.try({
              try: () =>
                backend.subscribeAttempt!((event) => {
                  if (closed || !accepting || !event) return
                  if (event.type === "snapshot") {
                    sawSnapshot = true
                    Queue.offerUnsafe(snapshots, event)
                    return
                  }
                  // The first terminal closes this callback generation. Its
                  // dedicated signal survives any snapshot burst.
                  accepting = false
                  Queue.offerUnsafe(terminals, undefined)
                }),
              catch: (cause) => providerError("source", cause),
            })

            const awaitTerminal = Effect.gen(function* () {
              // Drain the latest complete sample before invalidation. This
              // makes an already-blocked downstream consumer observe both
              // authoritative pieces of state in order.
              const latest = yield* Queue.poll(snapshots)
              if (Option.isSome(latest)) yield* emit(latest.value)
              yield* emit({ type: "invalidation", reason: "stream-terminated" })
            })

            const observe = (): Effect.Effect<AttemptResult, never> =>
              Effect.gen(function* () {
                const terminal = yield* Queue.poll(terminals)
                if (Option.isSome(terminal)) {
                  yield* awaitTerminal
                  return { sawSnapshot }
                }
                const next = yield* Queue.take(snapshots).pipe(
                  Effect.map((event) => ({ type: "snapshot" as const, event })),
                  Effect.race(
                    Queue.take(terminals).pipe(
                      Effect.as({ type: "terminal" as const }),
                    ),
                  ),
                )
                if (next.type === "terminal") {
                  yield* awaitTerminal
                  return { sawSnapshot }
                }
                yield* emit(next.event)
                return yield* observe()
              })

            // The source lifetime is exactly one attempt: terminal delivery
            // completes before its exact-once release, and interruption releases
            // it without allowing a retry to start.
            return yield* Effect.acquireUseRelease(
              acquireSource,
              () => observe(),
              (source) => {
                accepting = false
                return dispose(source).pipe(
                  // Disposal is a typed provider boundary. Report and recover
                  // so the terminal invalidation already handed downstream is
                  // not duplicated or allowed to kill supervision.
                  Effect.catch((error) => reportError(error)),
                )
              },
            )
          })

        const retries = yield* Ref.make(0)
        const successfulAttempts = yield* Queue.sliding<void>(1)
        const attempt = runAttempt().pipe(
          Effect.tap(({ sawSnapshot }) =>
            sawSnapshot
              ? Queue.offer(successfulAttempts, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.catch((error) =>
            // Startup has no callback terminal. Report its tagged boundary and
            // normalize it into the same invalidation/retry path.
            reportError(error).pipe(
              Effect.andThen(
                emit({ type: "invalidation", reason: "stream-terminated" }),
              ),
              Effect.as({ sawSnapshot: false }),
            ),
          ),
        )

        return yield* attempt.pipe(
          Effect.repeat(attemptRetrySchedule(retries, successfulAttempts)),
        )
      }),
    // The only queue shared with downstream is bounded and suspending. The
    // supervisor, never a raw callback, offers to it and thus terminal delivery
    // applies backpressure before a retry can begin.
    { bufferSize: 1, strategy: "suspend" },
  )
}

export type ProviderLayerHooks = {
  readonly onAcquire?: () => void
  readonly onFinalize?: () => void
  /** Test seam for status/probe failures without altering production probes. */
  readonly statusProbe?: () => ProviderStatus
}

const serviceFromAdapter = (
  backend: SystemMediaAttemptAdapter,
  hooks: ProviderLayerHooks = {},
) =>
  Effect.gen(function* () {
    // The Layer, rather than each caller, owns the one retry supervisor and
    // raw attempt. Consumers get subscriptions to this bounded multicast.
    const events = yield* eventsFromAttemptAdapter(backend).pipe(
      Stream.share({ capacity: 1, strategy: "suspend" }),
    )
    const sample = Effect.fn("MusicSession.Provider.sample")(function* () {
      return yield* Effect.tryPromise({
        try: () => backend.player(),
        catch: (cause) => providerError("sample", cause),
      })
    })
    const transport = Effect.fn("MusicSession.Provider.transport")(function* (
      action: TransportAction,
      positionMs?: number,
    ) {
      const run = yield* Effect.try({
        try: () =>
          action === "play"
            ? backend.play()
            : action === "pause"
              ? backend.pause?.()
              : action === "next"
                ? backend.next?.()
                : action === "previous"
                  ? backend.previous?.()
                  : backend.seek?.(positionMs ?? 0),
        catch: (cause) => providerError("transport", cause),
      })
      if (!run)
        return yield* Effect.fail(
          providerError("transport", new Error(`${action} unsupported`)),
        )
      return yield* Effect.tryPromise({
        try: () => run,
        catch: (cause) => providerError("transport", cause),
      })
    })
    return SessionProvider.of({
      status: Effect.fn("MusicSession.Provider.status")(function* () {
        return yield* Effect.try({
          try: hooks.statusProbe ?? status,
          catch: (cause) => providerError("status", cause),
        })
      }),
      sample,
      transport,
      events,
    })
  })

/** Factory seam for typed adapter-acquisition tests. */
export const layerFromAttemptFactory = (
  acquireAdapter: () => SystemMediaAttemptAdapter,
  hooks: ProviderLayerHooks = {},
) =>
  Layer.effect(
    SessionProvider,
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          hooks.onAcquire?.()
          return acquireAdapter()
        },
        catch: (cause) => providerError("acquisition", cause),
      }),
      () =>
        Effect.try({
          try: () => hooks.onFinalize?.(),
          catch: (cause) => providerError("finalize", cause),
        }).pipe(Effect.catch(() => Effect.void)),
    ).pipe(Effect.flatMap((backend) => serviceFromAdapter(backend, hooks))),
  )

/** Scoped adapter constructor used by focused provider lifecycle tests. */
export const layerFromAttemptAdapter = (
  backend: SystemMediaAttemptAdapter,
  hooks: ProviderLayerHooks = {},
) => layerFromAttemptFactory(() => backend, hooks)

/** One scoped adapter and one raw event attempt. Retry ownership belongs above this layer. */
export const layer = layerFromAttemptFactory(createSystemMediaAdapter)

/** Promise/callback fixture kept only at the explicit socket adapter boundary. */
export type LegacySessionProvider = {
  status(): Promise<ProviderStatus>
  sample(): Promise<PlayerState | null>
  subscribe(listener: (event: MusicChangeEvent) => void): () => void
  transport(action: TransportAction, positionMs?: number): Promise<void>
  dispose(): void
}

export const layerFromLegacy = (provider: LegacySessionProvider) =>
  Layer.effect(
    SessionProvider,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => provider.dispose()))
      const events = Stream.callback<MusicChangeEvent>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            provider.subscribe((event) => Queue.offerUnsafe(queue, event)),
          ),
          (dispose) => Effect.sync(dispose),
        ),
      )
      return SessionProvider.of({
        status: Effect.fn("MusicSession.Provider.status")(function* () {
          return yield* Effect.tryPromise({
            try: () => provider.status(),
            catch: (cause) => providerError("status", cause),
          })
        }),
        sample: Effect.fn("MusicSession.Provider.sample")(function* () {
          return yield* Effect.tryPromise({
            try: () => provider.sample(),
            catch: (cause) => providerError("sample", cause),
          })
        }),
        transport: Effect.fn("MusicSession.Provider.transport")(function* (
          action: TransportAction,
          positionMs?: number,
        ) {
          return yield* Effect.tryPromise({
            try: () => provider.transport(action, positionMs),
            catch: (cause) => providerError("transport", cause),
          })
        }),
        events,
      })
    }),
  )

export type FakeProvider = LegacySessionProvider & {
  emit(event: MusicChangeEvent): void
  blockSample(): void
  releaseSample(): void
  blockTransport(): void
  releaseTransport(): void
  failNextSample(cause?: Error): void
  returnNullNextSample(): void
  failNextTransport(cause?: Error): void
  calls: string[]
  counts: {
    subscriptions: number
    disposals: number
    providerDisposals: number
    samples: number
  }
  state: PlayerState
}

type Gate = { readonly wait: Promise<void>; readonly release: () => void }

const gate = (): Gate => {
  let release: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
export function createFakeProvider(
  initial: PlayerState = emptyPlayer(),
): FakeProvider {
  let listener: ((event: MusicChangeEvent) => void) | undefined
  let sampleGate: Gate | undefined
  let transportGate: Gate | undefined
  let nextSampleFailure: Error | undefined
  let nextSampleNull = false
  let nextTransportFailure: Error | undefined
  const fake: FakeProvider = {
    state: initial,
    calls: [],
    counts: {
      subscriptions: 0,
      disposals: 0,
      providerDisposals: 0,
      samples: 0,
    },
    async status() {
      return {
        kind: "ready",
        provider: "media-control",
        message: "fake provider",
      }
    },
    async sample() {
      fake.counts.samples++
      const failure = nextSampleFailure
      nextSampleFailure = undefined
      if (failure) throw failure
      if (nextSampleNull) {
        nextSampleNull = false
        return null
      }
      await sampleGate?.wait
      return fake.state
    },
    subscribe(next) {
      fake.counts.subscriptions++
      listener = next
      let done = false
      return () => {
        if (!done) {
          done = true
          fake.counts.disposals++
          listener = undefined
        }
      }
    },
    async transport(action, positionMs) {
      fake.calls.push(action)
      const failure = nextTransportFailure
      nextTransportFailure = undefined
      if (failure) throw failure
      await transportGate?.wait
      if (action === "play")
        fake.state = { ...fake.state, is_playing: true, fetched_at: Date.now() }
      if (action === "pause")
        fake.state = {
          ...fake.state,
          is_playing: false,
          fetched_at: Date.now(),
        }
      if (action === "seek")
        fake.state = {
          ...fake.state,
          progress_ms: positionMs ?? 0,
          fetched_at: Date.now(),
        }
    },
    emit(event) {
      listener?.(event)
    },
    blockSample() {
      sampleGate ??= gate()
    },
    releaseSample() {
      sampleGate?.release()
      sampleGate = undefined
    },
    blockTransport() {
      transportGate ??= gate()
    },
    releaseTransport() {
      transportGate?.release()
      transportGate = undefined
    },
    failNextSample(cause = new Error("fake sample failure")) {
      nextSampleFailure = cause
    },
    returnNullNextSample() {
      nextSampleNull = true
    },
    failNextTransport(cause = new Error("fake transport failure")) {
      nextTransportFailure = cause
    },
    dispose() {
      fake.counts.providerDisposals++
    },
  }
  return fake
}
