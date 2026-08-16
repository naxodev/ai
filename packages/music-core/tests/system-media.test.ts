import { beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  Clock,
  Duration,
  Effect,
  Fiber,
  Latch,
  Queue,
  Ref,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { trackKey } from "../clock.ts"
import { mergePlayer } from "../reconcile.ts"
import { run, startLineStream } from "../run.ts"
import {
  attemptRetrySchedule,
  eventsFromAttemptAdapter,
  layerFromAttemptAdapter,
  layerFromAttemptFactory,
  SessionProvider,
  type ProviderError,
} from "../session/provider.ts"
import {
  bundleLabel,
  createSystemMedia,
  createSystemMediaAdapter,
  effectiveBundle,
  resetMediaBackend,
  type SystemMediaDependencies,
} from "../system-media.ts"
import type { MusicChangeEvent } from "../types.ts"
import type { LineStreamCallbacks } from "../run.ts"

class FakeLineStreamProcess extends EventEmitter {
  stdout = new EventEmitter()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killCalls = 0

  kill() {
    this.killCalls++
  }
}

type FakeSource = {
  callbacks: LineStreamCallbacks
  disposed: number
}

function createStreamFakes(options?: {
  now?: () => number
  onAttemptStart?: () => void
}) {
  const sources: FakeSource[] = []
  const timers: Array<{
    callback: () => void
    delayMs: number
    active: boolean
  }> = []
  const timer = (callback: () => void, delayMs: number) => {
    const entry = { callback, delayMs, active: true }
    timers.push(entry)
    return entry as unknown as ReturnType<typeof setTimeout>
  }
  const clearTimer = (entry: ReturnType<typeof setTimeout>) => {
    ;(entry as unknown as { active: boolean }).active = false
  }
  const getCalls: string[][] = []
  const backend = createSystemMediaAdapter({
    detectBackend: () => "media-control",
    hasNowPlayingCli: () => false,
    run: async (cmd) => {
      getCalls.push(cmd)
      return { ok: true, out: "" }
    },
    startLineStream: (_cmd, callbacks) => {
      const source = { callbacks, disposed: 0 }
      sources.push(source)
      options?.onAttemptStart?.()
      return () => {
        source.disposed++
      }
    },
    setRetryTimer: timer,
    clearRetryTimer: clearTimer,
    ...(options?.now ? { now: options.now } : {}),
  })
  return {
    backend,
    sources,
    timers,
    getCalls,
    runNextTimer() {
      const next = timers.find((entry) => entry.active)
      if (!next) throw new Error("no active retry timer")
      next.active = false
      next.callback()
    },
  }
}

const completePausedPayload = {
  contentItemIdentifier: "provider-id",
  title: "Song",
  artist: "Artist",
  album: "Album",
  duration: 180,
  elapsedTimeNow: 12.5,
  playing: false,
  bundleIdentifier: "com.Spotify.client",
}

function dataEnvelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: "data", diff: false, payload })
}

beforeEach(() => {
  resetMediaBackend()
})

describe("one-attempt media-control seam", () => {
  test("never schedules a retry timer and terminal disposal is exact once", () => {
    const { backend, sources, timers } = createStreamFakes()
    const events: MusicChangeEvent[] = []
    const dispose = backend.subscribeAttempt?.((event) => {
      if (event) events.push(event)
    })

    expect(sources).toHaveLength(1)
    expect(timers).toHaveLength(0)
    const source = sources.at(0)
    if (!source) throw new Error("attempt source was not created")
    source.callbacks.onTerminal()
    source.callbacks.onTerminal()
    source.callbacks.onLine(dataEnvelope(completePausedPayload))
    expect(events).toEqual([
      { type: "invalidation", reason: "stream-terminated" },
    ])
    expect(source.disposed).toBe(1)
    dispose?.()
    expect(source.disposed).toBe(1)
  })

  test("handles synchronous terminal-before-return disposal exactly once", () => {
    let sourceDisposals = 0
    const events: MusicChangeEvent[] = []
    const backend = createSystemMediaAdapter({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async () => ({ ok: true, out: "" }),
      startLineStream: (_cmd, callbacks) => {
        callbacks.onTerminal()
        return () => {
          sourceDisposals++
        }
      },
    })

    const dispose = backend.subscribeAttempt?.((event) => {
      if (event) events.push(event)
    })
    dispose?.()

    expect(sourceDisposals).toBe(1)
    expect(events).toEqual([
      { type: "invalidation", reason: "stream-terminated" },
    ])
  })

  test("terminal disposal failure still emits invalidation and is recoverable once", () => {
    let sourceDisposals = 0
    let callbacks: LineStreamCallbacks | undefined
    const events: MusicChangeEvent[] = []
    const backend = createSystemMediaAdapter({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async () => ({ ok: true, out: "" }),
      startLineStream: (_cmd, next) => {
        callbacks = next
        return () => {
          sourceDisposals++
          throw new Error("raw source dispose failed")
        }
      },
    })
    const dispose = backend.subscribeAttempt?.((event) => {
      if (event) events.push(event)
    })

    callbacks?.onTerminal()
    expect(events).toEqual([
      { type: "invalidation", reason: "stream-terminated" },
    ])
    expect(sourceDisposals).toBe(1)
    expect(() => dispose?.()).toThrow("raw source dispose failed")
    expect(sourceDisposals).toBe(1)
    expect(() => dispose?.()).not.toThrow()
  })

  test("daemon retry schedule waits 1/2/4/8/8 seconds and resets after a snapshot", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const retries = yield* Ref.make(0)
          const snapshots = yield* Queue.sliding<void>(1)
          const attempts = yield* Ref.make(0)
          const firstAttempt = Latch.makeUnsafe()
          yield* Ref.update(attempts, (count) => count + 1).pipe(
            Effect.tap(() => Effect.sync(() => Latch.openUnsafe(firstAttempt))),
            Effect.repeat(attemptRetrySchedule(retries, snapshots)),
            Effect.forkScoped,
          )
          yield* Latch.await(firstAttempt)
          expect(yield* Ref.get(attempts)).toBe(1)

          const retry = (delay: Duration.Input, attemptsAfter: number) =>
            Effect.gen(function* () {
              yield* TestClock.adjust(delay)
              expect(yield* Ref.get(attempts)).toBe(attemptsAfter)
            })
          yield* retry("1 second", 2)
          yield* retry("2 seconds", 3)
          yield* retry("4 seconds", 4)
          yield* retry("8 seconds", 5)
          yield* retry("8 seconds", 6)

          // Multiple snapshots from one attempt collapse into one reset; none
          // may leak into later failed attempts.
          yield* Queue.offer(snapshots, undefined)
          yield* Queue.offer(snapshots, undefined)
          yield* retry("8 seconds", 7)
          yield* retry("1 second", 8)
          yield* retry("2 seconds", 9)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
  })

  test("daemon event stream applies integrated capped retries and snapshot reset under TestClock", async () => {
    const starts = Array.from({ length: 7 }, () => Latch.makeUnsafe())
    let startCount = 0
    const fake = createStreamFakes({
      onAttemptStart: () => Latch.openUnsafe(starts[startCount++]!),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          yield* eventsFromAttemptAdapter(fake.backend).pipe(
            Stream.runDrain,
            Effect.provideService(Clock.Clock, clock),
            Effect.forkScoped,
          )
          yield* Latch.await(starts[0]!)
          expect(fake.sources).toHaveLength(1)

          const failThenRetry = (delay: Duration.Input, next: number) =>
            Effect.gen(function* () {
              fake.sources.at(-1)?.callbacks.onTerminal()
              yield* clock.adjust(delay)
              yield* Latch.await(starts[next]!)
              expect(fake.sources).toHaveLength(next + 1)
            })
          yield* failThenRetry("1 second", 1)
          yield* failThenRetry("2 seconds", 2)
          yield* failThenRetry("4 seconds", 3)
          yield* failThenRetry("8 seconds", 4)
          yield* failThenRetry("8 seconds", 5)

          fake.sources[5]?.callbacks.onLine(dataEnvelope(completePausedPayload))
          yield* failThenRetry("1 second", 6)
        }),
      ),
    )
  })

  test("source startup failure invalidates and retries without terminating supervision", async () => {
    const firstStart = Latch.makeUnsafe()
    const secondStart = Latch.makeUnsafe()
    let starts = 0
    const errors: ProviderError[] = []
    const fake = createStreamFakes()
    fake.backend.subscribeAttempt = () => {
      starts++
      Latch.openUnsafe(starts === 1 ? firstStart : secondStart)
      throw new Error("source startup failed")
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          const observed = yield* Queue.bounded<MusicChangeEvent>(2)
          const worker = yield* eventsFromAttemptAdapter(fake.backend, {
            reportError: (error) => errors.push(error),
          }).pipe(
            Stream.runForEach((event) => Queue.offer(observed, event)),
            Effect.provideService(Clock.Clock, clock),
            Effect.forkScoped,
          )
          yield* Latch.await(firstStart)
          expect(yield* Queue.take(observed)).toEqual({
            type: "invalidation",
            reason: "stream-terminated",
          })
          expect(errors).toHaveLength(1)
          expect(errors[0]).toMatchObject({
            operation: "source",
            message: "source startup failed",
            cause: { cause: expect.any(Error) },
          })
          yield* clock.adjust("1 second")
          yield* Latch.await(secondStart)
          expect(starts).toBe(2)
          yield* Fiber.interrupt(worker)
        }),
      ),
    )
  })

  test("daemon retry wait interruption prevents another attempt", async () => {
    const started = Latch.makeUnsafe()
    const fake = createStreamFakes({
      onAttemptStart: () => Latch.openUnsafe(started),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          const worker = yield* eventsFromAttemptAdapter(fake.backend).pipe(
            Stream.runDrain,
            Effect.provideService(Clock.Clock, clock),
            Effect.forkScoped,
          )
          yield* Latch.await(started)
          fake.sources[0]?.callbacks.onTerminal()
          yield* Fiber.interrupt(worker)
          yield* clock.adjust("8 seconds")
          expect(fake.sources).toHaveLength(1)
          expect(fake.sources[0]?.disposed).toBe(1)
        }),
      ),
    )
  })

  test("daemon active-attempt interruption disposes once and suppresses late callbacks", async () => {
    const started = Latch.makeUnsafe()
    const fake = createStreamFakes({
      onAttemptStart: () => Latch.openUnsafe(started),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* eventsFromAttemptAdapter(fake.backend).pipe(
            Stream.runDrain,
            Effect.forkScoped,
          )
          yield* Latch.await(started)
          const source = fake.sources[0]
          if (!source) throw new Error("attempt source was not created")
          yield* Fiber.interrupt(worker)
          source.callbacks.onLine(dataEnvelope(completePausedPayload))
          source.callbacks.onTerminal()
          expect(source.disposed).toBe(1)
          expect(fake.sources).toHaveLength(1)
        }),
      ),
    )
  })

  test("source disposal failure remains tagged after terminal delivery", async () => {
    const started = Latch.makeUnsafe()
    const reported = Latch.makeUnsafe()
    const errors: ProviderError[] = []
    let listener: ((event: MusicChangeEvent) => void) | undefined
    const fake = createStreamFakes()
    fake.backend.subscribeAttempt = (next) => {
      listener = next
      Latch.openUnsafe(started)
      return () => {
        throw new Error("source dispose failed")
      }
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const observed = yield* Queue.bounded<MusicChangeEvent>(2)
          const worker = yield* eventsFromAttemptAdapter(fake.backend, {
            reportError: (error) => {
              errors.push(error)
              Latch.openUnsafe(reported)
            },
          }).pipe(
            Stream.runForEach((event) => Queue.offer(observed, event)),
            Effect.forkScoped,
          )
          yield* Latch.await(started)
          listener?.({ type: "invalidation", reason: "stream-terminated" })
          expect(yield* Queue.take(observed)).toEqual({
            type: "invalidation",
            reason: "stream-terminated",
          })
          yield* Latch.await(reported)
          expect(errors).toHaveLength(1)
          expect(errors[0]).toMatchObject({
            operation: "dispose",
            message: "source dispose failed",
            cause: { cause: expect.any(Error) },
          })
          yield* Fiber.interrupt(worker)
        }),
      ),
    )
  })

  test("scoped adapter layer finalizes its active source exactly once", async () => {
    const sourceStarted = Latch.makeUnsafe()
    const fake = createStreamFakes({
      onAttemptStart: () => Latch.openUnsafe(sourceStarted),
    })
    let acquisitions = 0
    let finalizations = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* SessionProvider
          yield* provider.events.pipe(Stream.runDrain, Effect.forkScoped)
          yield* Latch.await(sourceStarted)
          yield* provider.transport("pause")
        }),
      ).pipe(
        Effect.provide(
          layerFromAttemptAdapter(fake.backend, {
            onAcquire: () => acquisitions++,
            onFinalize: () => finalizations++,
          }),
        ),
      ),
    )
    expect(acquisitions).toBe(1)
    expect(finalizations).toBe(1)
    expect(fake.sources).toHaveLength(1)
    expect(fake.sources[0]?.disposed).toBe(1)
  })

  test("multiple provider event consumers share one active raw attempt", async () => {
    const sourceStarted = Latch.makeUnsafe()
    const firstEvent = Latch.makeUnsafe()
    const secondEvent = Latch.makeUnsafe()
    const fake = createStreamFakes({
      onAttemptStart: () => Latch.openUnsafe(sourceStarted),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* SessionProvider
          yield* provider.events.pipe(
            Stream.runForEach(() => Latch.open(firstEvent).pipe(Effect.asVoid)),
            Effect.forkScoped,
          )
          yield* Latch.await(sourceStarted)
          yield* provider.events.pipe(
            Stream.runForEach(() =>
              Latch.open(secondEvent).pipe(Effect.asVoid),
            ),
            Effect.forkScoped,
          )

          const source = fake.sources[0]
          if (!source) throw new Error("attempt source was not created")
          source.callbacks.onLine(dataEnvelope(completePausedPayload))
          yield* Latch.await(firstEvent)
          yield* Latch.await(secondEvent)
          expect(fake.sources).toHaveLength(1)
          expect(source.disposed).toBe(0)
        }),
      ).pipe(Effect.provide(layerFromAttemptAdapter(fake.backend))),
    )
    expect(fake.sources[0]?.disposed).toBe(1)
  })

  test("provider operations and adapter acquisition preserve one tagged boundary", async () => {
    const fake = createStreamFakes()
    const failures: ProviderError[] = []
    const backend = fake.backend
    backend.player = async () => {
      throw new Error("sample rejected")
    }
    backend.play = async () => {
      throw new Error("transport rejected")
    }
    delete backend.pause
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* SessionProvider
          yield* provider
            .status()
            .pipe(
              Effect.catch((error) => Effect.sync(() => failures.push(error))),
            )
          yield* provider
            .sample()
            .pipe(
              Effect.catch((error) => Effect.sync(() => failures.push(error))),
            )
          yield* provider
            .transport("pause")
            .pipe(
              Effect.catch((error) => Effect.sync(() => failures.push(error))),
            )
          yield* provider
            .transport("play")
            .pipe(
              Effect.catch((error) => Effect.sync(() => failures.push(error))),
            )
        }),
      ).pipe(
        Effect.provide(
          layerFromAttemptAdapter(backend, {
            statusProbe: () => {
              throw new Error("status probe failed")
            },
          }),
        ),
      ),
    )
    expect(failures).toHaveLength(4)
    expect(failures.map((failure) => failure.operation)).toEqual([
      "status",
      "sample",
      "transport",
      "transport",
    ])
    expect(failures.map((failure) => failure.message)).toEqual([
      "status probe failed",
      "sample rejected",
      "pause unsupported",
      "transport rejected",
    ])
    for (const failure of failures)
      expect(failure.cause).toEqual({ cause: expect.any(Error) })

    const acquisitionFailures: ProviderError[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* SessionProvider
        }),
      ).pipe(
        Effect.provide(
          layerFromAttemptFactory(() => {
            throw new Error("adapter creation failed")
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => acquisitionFailures.push(error)),
        ),
      ),
    )
    expect(acquisitionFailures).toHaveLength(1)
    expect(acquisitionFailures[0]).toMatchObject({
      operation: "acquisition",
      message: "adapter creation failed",
      cause: { cause: expect.any(Error) },
    })
  })

  test("bounded bridge retains the latest snapshot and a terminal under backpressure", async () => {
    const started = Latch.makeUnsafe()
    const release = Latch.makeUnsafe()
    const fake = createStreamFakes({
      onAttemptStart: () => Latch.openUnsafe(started),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const observed = yield* Queue.bounded<MusicChangeEvent>(8)
          let blockFirst = true
          const worker = yield* eventsFromAttemptAdapter(fake.backend).pipe(
            Stream.runForEach((event) =>
              Queue.offer(observed, event).pipe(
                Effect.andThen(
                  blockFirst
                    ? Effect.sync(() => {
                        blockFirst = false
                      }).pipe(Effect.andThen(Latch.await(release)))
                    : Effect.void,
                ),
              ),
            ),
            Effect.forkScoped,
          )
          yield* Latch.await(started)
          const source = fake.sources[0]
          if (!source) throw new Error("attempt source was not created")
          source.callbacks.onLine(dataEnvelope(completePausedPayload))
          expect(yield* Queue.take(observed)).toMatchObject({
            type: "snapshot",
            state: { track: { name: "Song" } },
          })

          source.callbacks.onLine(
            dataEnvelope({ ...completePausedPayload, title: "Middle" }),
          )
          source.callbacks.onLine(
            dataEnvelope({ ...completePausedPayload, title: "Latest" }),
          )
          source.callbacks.onTerminal()
          yield* Latch.open(release)

          expect(yield* Queue.take(observed)).toMatchObject({
            type: "snapshot",
            state: { track: { name: "Latest" } },
          })
          expect(yield* Queue.take(observed)).toEqual({
            type: "invalidation",
            reason: "stream-terminated",
          })
          expect(source.disposed).toBe(1)
          yield* Fiber.interrupt(worker)
        }),
      ),
    )
  })
})

describe("trackKey", () => {
  // Providers without content ids still need a stable playback key.
  test("uses stable metadata when the provider has no content identifier", () => {
    expect(trackKey("Song", "Artist", "")).toBe("Song\0Artist")
    expect(trackKey("Song", "Artist", "provider-id")).toBe(
      "provider-id\0Song\0Artist",
    )
  })
})

describe("bundleLabel / effectiveBundle", () => {
  // Device label must name the real player for the host UI.
  test.each([
    ["com.Spotify.client", "Spotify"],
    ["com.apple.Music", "Apple Music"],
    ["com.google.Chrome", "Chrome"],
    [null, "System media"],
  ])("labels %s as %s", (bundle, expected) => {
    expect(bundleLabel(bundle)).toBe(expected)
  })

  // Prefer parent over WebKit GPU so Browser/Kaset labels stay truthful.
  test("maps known bundles and prefers parent over WebKit GPU", () => {
    expect(bundleLabel("com.Spotify.client")).toBe("Spotify")

    const resolved = effectiveBundle({
      bundleIdentifier: "com.apple.WebKit.GPU",
      parentApplicationBundleIdentifier: "app.Kaset.desktop",
    })
    expect(resolved).toBe("app.Kaset.desktop")
    expect(bundleLabel(resolved)).toBe("Kaset")

    expect(
      bundleLabel(
        effectiveBundle({
          bundleIdentifier: "com.apple.WebKit.GPU",
          parentApplicationBundleIdentifier: null,
        }),
      ),
    ).toBe("Browser")
  })
})

describe("native artwork adapter boundary", () => {
  const identity = {
    id: "provider-id",
    name: "Song",
    artists: "Artist",
    album: "Album",
    duration_ms: 180_000,
  }
  const nativePayload = (overrides: Record<string, unknown> = {}) => ({
    contentItemIdentifier: identity.id,
    title: identity.name,
    artist: identity.artists,
    album: identity.album,
    duration: 180,
    artworkData: "AQID",
    ...overrides,
  })
  const native = (payload: unknown, calls: string[][] = []) => {
    const backend = createSystemMediaAdapter({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) => {
        calls.push(command)
        return { ok: true, out: JSON.stringify(payload) }
      },
    })
    if (!backend.nativeArtwork) throw new Error("expected native artwork seam")
    return { read: backend.nativeArtwork, calls }
  }

  test("uses the artwork-only get command and accepts the exact full identity", async () => {
    const adapter = native(nativePayload())
    await expect(adapter.read(identity, 3)).resolves.toEqual({
      type: "available",
      base64: "AQID",
    })
    expect(adapter.calls).toEqual([["media-control", "get", "--now"]])
  })

  test("rejects every native identity mismatch as stale", async () => {
    for (const [field, value] of [
      ["contentItemIdentifier", "other-id"],
      ["title", "Other"],
      ["artist", "Other"],
      ["album", "Other"],
      ["duration", 181],
    ] as const) {
      const adapter = native(nativePayload({ [field]: value }))
      await expect(adapter.read(identity, 3)).resolves.toEqual({
        type: "stale",
      })
    }
  })

  test("contains malformed, absent, and oversized native data", async () => {
    for (const payload of [
      null,
      nativePayload({ artworkData: "" }),
      nativePayload({ artworkData: "not base64" }),
      nativePayload({ artworkData: "AR==" }),
    ]) {
      const adapter = native(payload)
      await expect(adapter.read(identity, 3)).resolves.toEqual({
        type: "unavailable",
      })
    }
    const boundary = native(nativePayload({ artworkData: "AQID" }))
    await expect(boundary.read(identity, 3)).resolves.toEqual({
      type: "available",
      base64: "AQID",
    })
    await expect(boundary.read(identity, 2)).resolves.toEqual({
      type: "too-large",
    })
    await expect(
      native(nativePayload({ contentItemIdentifier: null })).read(identity, 3),
    ).resolves.toEqual({ type: "stale" })
    const malformed = createSystemMediaAdapter({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async () => ({ ok: true, out: "{" }),
    })
    await expect(malformed.nativeArtwork?.(identity, 3)).resolves.toEqual({
      type: "unavailable",
    })
  })

  test("keeps ordinary sampling and stream commands artwork-free", async () => {
    const commands: string[][] = []
    const backend = createSystemMediaAdapter({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) => {
        commands.push(command)
        return {
          ok: true,
          out: JSON.stringify({
            ...nativePayload(),
            elapsedTimeNow: 0,
            playing: false,
          }),
        }
      },
      startLineStream: (command) => {
        commands.push(command)
        return () => {}
      },
    })
    await backend.player()
    backend.subscribeAttempt?.(() => {})()
    if (!backend.nativeArtwork) throw new Error("expected native artwork seam")
    await backend.nativeArtwork(identity, 3)
    expect(commands).toEqual([
      ["media-control", "get", "--no-artwork", "--now"],
      ["media-control", "stream", "--no-diff", "--no-artwork"],
      ["media-control", "get", "--now"],
    ])
  })

  test("returns unavailable off media-control and propagates command failures", async () => {
    const fallback = createSystemMediaAdapter({
      detectBackend: () => "nowplaying-cli",
      hasNowPlayingCli: () => true,
      run: async () => ({ ok: true, out: "" }),
    })
    expect(fallback.nativeArtwork).toBeUndefined()
    for (const result of [
      { ok: false as const, err: "command rejected", timed_out: false },
      { ok: false as const, err: "command timed out", timed_out: true },
    ]) {
      const failing = createSystemMediaAdapter({
        detectBackend: () => "media-control",
        hasNowPlayingCli: () => false,
        run: async () => result,
      })
      await expect(failing.nativeArtwork?.(identity, 3)).rejects.toThrow(
        result.err,
      )
    }
  })
})

describe("media command boundaries", () => {
  test("keeps the raw provider id separate from the playback clock key", async () => {
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async () => ({
        ok: true,
        out: JSON.stringify({
          contentItemIdentifier: "provider-id",
          title: "Song",
          artist: "Artist",
          duration: 180,
          elapsedTimeNow: 10,
          playing: false,
        }),
      }),
    })

    const state = await backend.player()

    expect(state?.track?.id).toBe("provider-id")
    expect(
      trackKey(state!.track!.name, state!.track!.artists, state!.track!.id),
    ).toBe("provider-id\0Song\0Artist")
  })

  test("a blank title sample keeps provider identity for host reconciliation", async () => {
    const samples = [
      {
        contentItemIdentifier: "provider-id",
        title: "Song",
        artist: "Artist",
        duration: 180,
        elapsedTimeNow: 10,
        playing: false,
      },
      {
        contentItemIdentifier: "provider-id",
        title: "",
        artist: "",
        duration: 180,
        elapsedTimeNow: 10,
        playing: false,
      },
    ]
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async () => ({ ok: true, out: JSON.stringify(samples.shift()) }),
    })

    const initial = await backend.player()
    const incomplete = await backend.player()
    const reconciled = mergePlayer(initial, incomplete)

    expect(incomplete?.track?.id).toBe("provider-id")
    expect(reconciled?.track?.name).toBe("Song")
    expect(reconciled?.track?.artists).toBe("Artist")
    expect(reconciled?.progress_ms).toBe(10_000)
    expect(reconciled?.is_playing).toBe(false)
  })

  // A wedged provider must not hang the poll loop forever.
  test("default run times out with a stable timed_out result", async () => {
    const result = await run(["sleep", "1"], 50)

    expect(result).toEqual({
      ok: false,
      err: "command timed out after 50ms",
      timed_out: true,
    })
  })

  // Preferred media-control failure must fall through to nowplaying-cli.
  test("keeps the current track visible through the fallback when the preferred provider times out", async () => {
    const providers: string[] = []
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => true,
      run: async ([provider]) => {
        providers.push(provider!)
        if (provider === "media-control") {
          return { ok: false, err: "command timed out", timed_out: true }
        }
        return {
          ok: true,
          out: JSON.stringify({
            title: "Fallback Song",
            artist: "Fallback Artist",
            album: "",
            duration: 180,
            elapsedTime: 30,
            playbackRate: 1,
            isPlaying: true,
          }),
        }
      },
    })

    const player = await backend.player()

    expect(providers).toEqual(["media-control", "nowplaying-cli"])
    expect(player?.track?.name).toBe("Fallback Song")
    expect(player?.track?.artists).toBe("Fallback Artist")
    expect(player?.is_playing).toBe(true)
  })

  // Transport argv maps must stay stable for both backends.
  test("play maps to the preferred backend argv", async () => {
    const calls: string[][] = []
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (cmd) => {
        calls.push(cmd)
        return { ok: true, out: "" }
      },
    })

    await backend.play()
    expect(calls).toEqual([["media-control", "play"]])
  })

  test("failed transport commands do not corrupt the sampled clock", async () => {
    const sample = {
      contentItemIdentifier: "provider-id",
      title: "Song",
      artist: "Artist",
      duration: 180,
      elapsedTimeNow: 10,
      playing: false,
    }
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) =>
        command[1] === "get"
          ? { ok: true, out: JSON.stringify(sample) }
          : {
              ok: false,
              err: "provider rejected command",
              timed_out: false,
            },
    })
    await backend.player()

    await expect(backend.play()).rejects.toEqual({
      status: 500,
      message: "provider rejected command",
    })
    await expect(backend.seek?.(50_000)).rejects.toEqual({
      status: 500,
      message: "provider rejected command",
    })
    const unchanged = await backend.player()

    expect(unchanged?.is_playing).toBe(false)
    expect(unchanged?.progress_ms).toBe(10_000)
  })
})

describe("startLineStream", () => {
  test("forwards complete lines across split and multi-line chunks", () => {
    const child = new FakeLineStreamProcess()
    const lines: string[] = []
    startLineStream(
      ["media-control", "stream"],
      { onLine: (line) => lines.push(line), onTerminal: () => {} },
      () => child,
    )

    child.stdout.emit("data", "first\nsec")
    child.stdout.emit("data", "ond\n\nthird\n")

    expect(lines).toEqual(["first", "second", "third"])
  })

  test("disposal removes listeners, discards partial output, and kills the child", () => {
    const child = new FakeLineStreamProcess()
    const lines: string[] = []
    const dispose = startLineStream(
      ["media-control", "stream"],
      { onLine: (line) => lines.push(line), onTerminal: () => {} },
      () => child,
    )

    child.stdout.emit("data", "partial")
    dispose()
    child.stdout.emit("data", " line\n")

    expect(child.stdout.listenerCount("data")).toBe(0)
    expect(child.listenerCount("error")).toBe(0)
    expect(child.listenerCount("exit")).toBe(0)
    expect(child.listenerCount("close")).toBe(0)
    expect(child.killCalls).toBe(1)
    expect(lines).toEqual([])
  })

  test("stops remaining lines when a line callback disposes the stream", () => {
    const child = new FakeLineStreamProcess()
    const lines: string[] = []
    let dispose = () => {}
    dispose = startLineStream(
      ["media-control", "stream"],
      {
        onLine: (line) => {
          lines.push(line)
          dispose()
        },
        onTerminal: () => {},
      },
      () => child,
    )

    child.stdout.emit("data", "first\nsecond\n")

    expect(lines).toEqual(["first"])
  })

  test("notifies once when error, exit, and close arrive together", () => {
    const child = new FakeLineStreamProcess()
    let terminals = 0
    startLineStream(
      ["media-control", "stream"],
      { onLine: () => {}, onTerminal: () => terminals++ },
      () => child,
    )

    child.emit("error", new Error("stream failed"))
    child.emit("exit", 1)
    child.emit("close", 1)

    expect(terminals).toBe(1)
  })
})

describe("media-control stream subscription", () => {
  test("keeps stream hooks optional for existing dependency objects", () => {
    const dependencies = {
      run: async () => ({ ok: true, out: "", err: "" }),
      detectBackend: () => null,
      hasNowPlayingCli: () => false,
    } satisfies SystemMediaDependencies

    expect(createSystemMedia(dependencies).subscribe).toBeUndefined()
  })

  // App-originated pause must land immediately from the stream without polling.
  test("emits an authoritative paused snapshot without calling player()", () => {
    const arrival = 1_700_000_000_000
    const fake = createStreamFakes({ now: () => arrival })
    const events: MusicChangeEvent[] = []
    fake.backend.subscribe?.((event) => {
      if (event) events.push(event)
    })

    fake.sources[0]!.callbacks.onLine(dataEnvelope(completePausedPayload))

    expect(fake.getCalls).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: "snapshot",
      state: {
        is_playing: false,
        progress_ms: 12_500,
        shuffle: false,
        repeat: "off",
        device: {
          id: "system",
          name: "Spotify",
          type: "Computer",
          is_active: true,
          volume_percent: null,
          supports_volume: false,
        },
        track: {
          id: "provider-id",
          uri: "system:now:Song",
          name: "Song",
          artists: "Artist",
          album: "Album",
          duration_ms: 180_000,
        },
        fetched_at: arrival,
      },
    })
  })

  // Polled get and stream payloads must share one decoder and arrival clock.
  test("player() and stream snapshots share normalization and arrival timestamps", async () => {
    const arrival = 1_700_000_000_500
    const payload = {
      ...completePausedPayload,
      elapsedTimeNow: 20,
      playing: true,
    }
    const backend = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      now: () => arrival,
      run: async () => ({ ok: true, out: JSON.stringify(payload) }),
      startLineStream: (_cmd, callbacks) => {
        queueMicrotask(() => callbacks.onLine(dataEnvelope(payload)))
        return () => {}
      },
      setRetryTimer: setTimeout,
      clearRetryTimer: clearTimeout,
    })

    const polled = await backend.player()
    let streamed: MusicChangeEvent | undefined
    backend.subscribe?.((event) => {
      streamed = event
    })
    await Promise.resolve()

    expect(streamed?.type).toBe("snapshot")
    if (streamed?.type !== "snapshot") throw new Error("expected snapshot")
    expect(polled).not.toBeNull()
    expect(streamed.state).toEqual(polled!)
    expect(polled!.fetched_at).toBe(arrival)
    expect(polled!.is_playing).toBe(true)
    expect(polled!.progress_ms).toBe(20_000)
  })

  // Bad stream output must not wedge the next valid provider event.
  test("ignores malformed, non-data, and incomplete envelopes then accepts a valid one", () => {
    const fake = createStreamFakes({ now: () => 42 })
    const events: MusicChangeEvent[] = []
    fake.backend.subscribe?.((event) => {
      if (event) events.push(event)
    })

    const source = fake.sources[0]!
    source.callbacks.onLine("not json")
    source.callbacks.onLine('{"type":"data","payload":null}')
    source.callbacks.onLine('{"type":"data","payload":[]}')
    source.callbacks.onLine('{"type":"status","payload":{}}')
    source.callbacks.onLine('{"type":"data","payload":{}}')
    source.callbacks.onLine(dataEnvelope({ elapsedTime: 10, timestamp: "now" }))
    // Boolean-only and identity-only payloads are partial — do not invent defaults.
    source.callbacks.onLine(dataEnvelope({ playing: false }))
    source.callbacks.onLine(dataEnvelope({ title: "Song" }))
    source.callbacks.onLine(
      dataEnvelope({
        title: "Song",
        artist: "Artist",
        album: "Album",
        playing: false,
      }),
    )
    source.callbacks.onLine(dataEnvelope(completePausedPayload))

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("snapshot")
    if (events[0]?.type !== "snapshot") throw new Error("expected snapshot")
    expect(events[0].state.is_playing).toBe(false)
    expect(events[0].state.track?.name).toBe("Song")
    expect(events[0].state.progress_ms).toBe(12_500)
  })

  // Complete idle still emits; empty/null values are valid when the shape is full.
  test("emits idle from a complete payload with empty identity values", () => {
    const arrival = 99
    const fake = createStreamFakes({ now: () => arrival })
    const events: MusicChangeEvent[] = []
    fake.backend.subscribe?.((event) => {
      if (event) events.push(event)
    })

    fake.sources[0]!.callbacks.onLine(
      dataEnvelope({
        contentItemIdentifier: null,
        title: "",
        artist: "",
        album: "",
        duration: 0,
        elapsedTime: 0,
        playing: false,
        bundleIdentifier: null,
      }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: "snapshot",
      state: {
        is_playing: false,
        progress_ms: 0,
        shuffle: false,
        repeat: "off",
        device: {
          id: "system",
          name: "Nothing playing",
          type: "Computer",
          is_active: false,
          volume_percent: null,
          supports_volume: false,
        },
        track: null,
        fetched_at: arrival,
      },
    })
  })

  // Existing no-arg listeners must keep compiling and receiving calls.
  test("supports listeners that ignore the event argument", () => {
    const fake = createStreamFakes()
    let changes = 0
    fake.backend.subscribe?.(() => {
      changes++
    })

    fake.sources[0]!.callbacks.onLine(dataEnvelope(completePausedPayload))
    expect(changes).toBe(1)
  })

  test("terminal error/exit/close emit one immediate invalidation and one restart", () => {
    const fake = createStreamFakes()
    const events: MusicChangeEvent[] = []
    fake.backend.subscribe?.((event) => {
      if (event) events.push(event)
    })

    fake.sources[0]!.callbacks.onTerminal()
    fake.sources[0]!.callbacks.onTerminal()
    fake.sources[0]!.callbacks.onTerminal()

    expect(events).toEqual([
      { type: "invalidation", reason: "stream-terminated" },
    ])
    expect(fake.timers.filter((entry) => entry.active)).toHaveLength(1)
    expect(fake.timers.map((entry) => entry.delayMs)).toEqual([1_000])
    fake.runNextTimer()
    expect(fake.sources).toHaveLength(2)
  })

  test("disposal from an invalidation listener does not leave a retry timer", () => {
    const fake = createStreamFakes()
    let dispose: (() => void) | undefined
    dispose = fake.backend.subscribe!((event) => {
      if (event?.type === "invalidation") dispose?.()
    })

    fake.sources[0]!.callbacks.onTerminal()

    expect(fake.timers.filter((entry) => entry.active)).toHaveLength(0)
    expect(fake.sources[0]!.disposed).toBe(1)
  })

  test("retry delays cap at 1/2/4/8 seconds and reset after a valid snapshot", () => {
    const fake = createStreamFakes()
    fake.backend.subscribe?.(() => {})

    fake.sources[0]!.callbacks.onTerminal()
    fake.runNextTimer()
    fake.sources[1]!.callbacks.onTerminal()
    fake.runNextTimer()
    fake.sources[2]!.callbacks.onTerminal()
    fake.runNextTimer()
    fake.sources[3]!.callbacks.onTerminal()
    fake.runNextTimer()
    fake.sources[4]!.callbacks.onTerminal()

    expect(fake.timers.map((entry) => entry.delayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000,
    ])

    fake.runNextTimer()
    fake.sources[5]!.callbacks.onLine(dataEnvelope(completePausedPayload))
    fake.sources[5]!.callbacks.onTerminal()

    expect(fake.timers.map((entry) => entry.delayMs).at(-1)).toBe(1_000)
  })

  test("nowplaying-cli remains polling-only and returns normalized state", async () => {
    const backend = createSystemMedia({
      detectBackend: () => "nowplaying-cli",
      hasNowPlayingCli: () => true,
      run: async () => ({
        ok: true,
        out: JSON.stringify({
          title: "Cli Song",
          artist: "Cli Artist",
          album: "Cli Album",
          duration: 90,
          elapsedTime: 15,
          playbackRate: 1,
          isPlaying: true,
        }),
      }),
      startLineStream: () => () => {},
      setRetryTimer: setTimeout,
      clearRetryTimer: clearTimeout,
    })

    expect(backend.subscribe).toBeUndefined()
    const state = await backend.player()
    expect(state?.track?.name).toBe("Cli Song")
    expect(state?.track?.artists).toBe("Cli Artist")
    expect(state?.progress_ms).toBe(15_000)
    expect(state?.is_playing).toBe(true)
  })

  test("two backends keep independent sampled and transport-mutated clocks", async () => {
    const leftSample = {
      contentItemIdentifier: "left-id",
      title: "Left Song",
      artist: "Left Artist",
      duration: 180,
      elapsedTimeNow: 10,
      playing: true,
    }
    const rightSample = {
      contentItemIdentifier: "right-id",
      title: "Right Song",
      artist: "Right Artist",
      duration: 240,
      elapsedTimeNow: 40,
      playing: false,
    }
    const left = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      now: () => 1_000_000,
      run: async (command) =>
        command[1] === "get"
          ? { ok: true, out: JSON.stringify(leftSample) }
          : { ok: true, out: "" },
    })
    const right = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      now: () => 1_000_000,
      run: async (command) =>
        command[1] === "get"
          ? { ok: true, out: JSON.stringify(rightSample) }
          : { ok: true, out: "" },
    })

    expect((await left.player())?.track?.name).toBe("Left Song")
    expect((await right.player())?.track?.name).toBe("Right Song")

    await left.pause?.()
    await right.play()
    await left.seek?.(2_000)
    await right.seek?.(55_000)

    leftSample.elapsedTimeNow = 10
    leftSample.playing = true
    rightSample.elapsedTimeNow = 40
    rightSample.playing = false

    // Sticky transport mutations survive a later sample that omits playing/progress.
    const leftSticky = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) =>
        command[1] === "get"
          ? {
              ok: true,
              out: JSON.stringify({
                contentItemIdentifier: "left-id",
                title: "Left Song",
                artist: "Left Artist",
                duration: 180,
                playing: false,
              }),
            }
          : { ok: true, out: "" },
    })
    const rightSticky = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      run: async (command) =>
        command[1] === "get"
          ? {
              ok: true,
              out: JSON.stringify({
                contentItemIdentifier: "right-id",
                title: "Right Song",
                artist: "Right Artist",
                duration: 240,
                playing: true,
              }),
            }
          : { ok: true, out: "" },
    })

    await leftSticky.player()
    await rightSticky.player()
    await leftSticky.pause?.()
    await rightSticky.play()
    await leftSticky.seek?.(3_000)
    await rightSticky.seek?.(70_000)
    await leftSticky.next?.()
    await rightSticky.previous?.()

    const leftAfterSkip = await leftSticky.player()
    const rightAfterSkip = await rightSticky.player()

    // next/previous reset only the owning backend clock before the next sample.
    expect(leftAfterSkip?.progress_ms).toBe(0)
    expect(rightAfterSkip?.progress_ms).toBe(0)
    expect(leftAfterSkip?.track?.name).toBe("Left Song")
    expect(rightAfterSkip?.track?.name).toBe("Right Song")
  })

  test("two live backends do not cross-contaminate pause and seek state", async () => {
    const leftPayload = {
      contentItemIdentifier: "left-id",
      title: "Left Song",
      artist: "Left Artist",
      duration: 180,
      elapsedTimeNow: 10,
      playing: true,
    }
    const rightPayload = {
      contentItemIdentifier: "right-id",
      title: "Right Song",
      artist: "Right Artist",
      duration: 240,
      elapsedTimeNow: 40,
      playing: false,
    }
    const left = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      now: () => 1_000_000,
      run: async (command) =>
        command[1] === "get"
          ? { ok: true, out: JSON.stringify(leftPayload) }
          : { ok: true, out: "" },
    })
    const right = createSystemMedia({
      detectBackend: () => "media-control",
      hasNowPlayingCli: () => false,
      now: () => 1_000_000,
      run: async (command) =>
        command[1] === "get"
          ? { ok: true, out: JSON.stringify(rightPayload) }
          : { ok: true, out: "" },
    })

    await left.player()
    await right.player()
    await left.pause?.()
    await right.play()
    await left.seek?.(2_500)
    await right.seek?.(51_000)

    // Drop reported progress so sticky clock state is observable.
    delete (leftPayload as { elapsedTimeNow?: number }).elapsedTimeNow
    delete (rightPayload as { elapsedTimeNow?: number }).elapsedTimeNow
    leftPayload.playing = true
    rightPayload.playing = false

    const leftState = await left.player()
    const rightState = await right.player()

    expect(leftState?.is_playing).toBe(true)
    expect(rightState?.is_playing).toBe(false)
    expect(leftState?.progress_ms).toBe(2_500)
    expect(rightState?.progress_ms).toBe(51_000)
    expect(leftState?.track?.name).toBe("Left Song")
    expect(rightState?.track?.name).toBe("Right Song")
  })

  test("disposal cancels retries, stops the source once, and suppresses late events", () => {
    const fake = createStreamFakes()
    const events: MusicChangeEvent[] = []
    const dispose = fake.backend.subscribe!((event) => {
      if (event) events.push(event)
    })
    const source = fake.sources[0]!

    source.callbacks.onTerminal()
    expect(events).toEqual([
      { type: "invalidation", reason: "stream-terminated" },
    ])
    dispose()
    dispose()
    source.callbacks.onLine(dataEnvelope(completePausedPayload))
    source.callbacks.onTerminal()
    fake.timers[0]!.callback()

    expect(source.disposed).toBe(1)
    expect(fake.timers[0]!.active).toBeFalse()
    expect(events).toHaveLength(1)
    expect(fake.sources).toHaveLength(1)
  })
})
