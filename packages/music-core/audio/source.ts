import { Effect, Result, Schema, Stream } from "effect"
import {
  selectionMatchesIdentity,
  type ResolvedCaptureSource,
} from "./schema.ts"

/**
 * Structured provider hints are metadata, not validated capture identities.
 * Each observation replaces the previous hint. Callers must not copy an older
 * process id onto a newer player snapshot.
 */
export type ProviderSourceHint = {
  readonly bundleIdentifier?: string
  readonly parentBundleIdentifier?: string
  readonly processIdentifier?: number
}

export type ProviderSourceObservation = {
  readonly sequence: number
  readonly kind: "snapshot" | "invalidation" | "unavailable"
  readonly hint: ProviderSourceHint | undefined
}

export const unavailableProviderSourceObservation: ProviderSourceObservation = {
  sequence: 0,
  kind: "unavailable",
  hint: undefined,
}

const boundedHint = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 1_024
    ? value
    : undefined

const SourceHintInput = Schema.Struct({
  bundleIdentifier: Schema.optionalKey(Schema.Unknown),
  parentApplicationBundleIdentifier: Schema.optionalKey(Schema.Unknown),
  processIdentifier: Schema.optionalKey(Schema.Unknown),
})

export const readProviderSourceHint = (
  payload: unknown,
): ProviderSourceHint | undefined => {
  const decoded = Schema.decodeUnknownResult(SourceHintInput)(payload)
  if (Result.isFailure(decoded)) return undefined
  const bundleIdentifier = boundedHint(decoded.success.bundleIdentifier)
  const parentBundleIdentifier = boundedHint(
    decoded.success.parentApplicationBundleIdentifier,
  )
  const processValue = decoded.success.processIdentifier
  const processIdentifier =
    typeof processValue === "number" &&
    Number.isSafeInteger(processValue) &&
    processValue > 0
      ? processValue
      : undefined
  if (
    bundleIdentifier === undefined &&
    parentBundleIdentifier === undefined &&
    processIdentifier === undefined
  )
    return undefined
  return {
    ...(bundleIdentifier === undefined ? {} : { bundleIdentifier }),
    ...(parentBundleIdentifier === undefined ? {} : { parentBundleIdentifier }),
    ...(processIdentifier === undefined ? {} : { processIdentifier }),
  }
}

export type SourceObservationListener = (
  observation: ProviderSourceObservation,
) => void

export type SourceObservationTicket = {
  readonly sequence: number
}

/**
 * Reservations are taken before an async read. A completion publishes only if
 * no newer reservation has already completed, so an older poll cannot replace
 * a newer stream snapshot.
 */
export type ProviderSourceObservationBus = {
  readonly reserve: () => SourceObservationTicket
  readonly complete: (
    ticket: SourceObservationTicket,
    kind: ProviderSourceObservation["kind"],
    hint: ProviderSourceHint | undefined,
  ) => ProviderSourceObservation | undefined
  readonly subscribe: (listener: SourceObservationListener) => () => void
  readonly latest: () => ProviderSourceObservation
}

export const makeProviderSourceObservationBus =
  (): ProviderSourceObservationBus => {
    let next = 0
    let published = 0
    let latest = unavailableProviderSourceObservation
    const listeners = new Set<SourceObservationListener>()
    const emit = (observation: ProviderSourceObservation) => {
      for (const listener of listeners) listener(observation)
    }
    return {
      latest: () => latest,
      reserve: () => {
        next += 1
        return { sequence: next }
      },
      complete: (ticket, kind, hint) => {
        if (ticket.sequence <= published) return undefined
        published = ticket.sequence
        latest = { sequence: ticket.sequence, kind, hint }
        emit(latest)
        return latest
      },
      subscribe: (listener) => {
        listener(latest)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
  }

export const unavailableSourceObservations: Stream.Stream<ProviderSourceObservation> =
  Stream.make(unavailableProviderSourceObservation).pipe(
    Stream.concat(Stream.never),
  )

export type AudioCatalog = {
  readonly availability: "available" | "unavailable"
  readonly reason?: "capture-adapter-unavailable"
  readonly sources: ReadonlyArray<ResolvedCaptureSource>
}

export type ObservationVerdict = "same" | "changed" | "unresolved"

export type AudioSourceResolver = {
  readonly list: () => Effect.Effect<AudioCatalog>
  readonly revalidate: (
    source: ResolvedCaptureSource,
  ) => Effect.Effect<ResolvedCaptureSource | undefined>
  readonly confirm: (
    active: ResolvedCaptureSource,
    observation: ProviderSourceObservation,
  ) => Effect.Effect<ObservationVerdict>
}

export const unavailableAudioSourceResolver: AudioSourceResolver = {
  list: Effect.fn("AudioSource.unavailable.list")(function* () {
    return {
      availability: "unavailable" as const,
      reason: "capture-adapter-unavailable" as const,
      sources: [],
    }
  }),
  revalidate: Effect.fn("AudioSource.unavailable.revalidate")(
    function* (source) {
      return yield* Effect.succeed(source).pipe(Effect.as(undefined))
    },
  ),
  confirm: Effect.fn("AudioSource.unavailable.confirm")(
    function* (active, observation) {
      return yield* Effect.succeed({ active, observation }).pipe(
        Effect.as("unresolved" as const),
      )
    },
  ),
}

export const acceptResolvedSource = (
  source: ResolvedCaptureSource,
): source is ResolvedCaptureSource => selectionMatchesIdentity(source)
