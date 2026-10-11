/** Application discovery uses a separate pinned helper and no capture adapter. */
import { Effect, Schema } from "effect"
import {
  helperError,
  type NativeHelperDependencies,
} from "../../audio/helper-process.ts"
import { readLocalKasetCatalog } from "../../audio/local-kaset.ts"
import { applicationDiscovery } from "./application-discovery.ts"
import { DiscoveryCount, witnessArguments } from "./discovery-check.ts"
import {
  makeBoundedProbeInspector,
  type ReadProbeJson,
} from "./bounded-probe-process.ts"

const Preflight = Schema.Struct({
  event: Schema.Literal("sck-application-preflight"),
  scope: Schema.Literal("kaset-application"),
  identity: Schema.Struct({
    processIdentifier: Schema.Finite.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(2147483647),
    ),
    launchIdentity: Schema.String.check(
      Schema.isPattern(/^\d+:\d+$/),
      Schema.isMaxLength(512),
    ),
    executableIdentity: Schema.String.check(
      Schema.isPattern(
        /^\/Applications\/Kaset\.app\/Contents\/MacOS\/Kaset\|[0-9a-f]{40}$/,
      ),
    ),
  }),
})
const ApplicationSummary = Schema.Struct({
  event: Schema.Literal("sck-application-discovery"),
  scope: Schema.Literal("kaset-application"),
  applicationChecks: Schema.Literal("passed-before-and-after"),
  witnessChecks: Schema.Literal("passed-before-and-after"),
  matchingApplications: Schema.Literal(1),
  witnessMatches: DiscoveryCount,
  displayCount: DiscoveryCount.check(Schema.isGreaterThan(0)),
})
interface ApplicationSummary extends Schema.Schema.Type<
  typeof ApplicationSummary
> {}

/** Keep application and witness identities in memory across a one-shot claim. */
export const prepareApplicationArguments = (profile: {
  helperPath: string
  helperIdentifier: string
  preflightFlag: string
}) =>
  Effect.fn("SckApplication.prepare")(function* (
    boundary: NativeHelperDependencies,
    readJson: ReadProbeJson,
  ) {
    const catalog = yield* readLocalKasetCatalog({
      ...boundary,
      verify: () =>
        boundary.verify(profile.helperPath, profile.helperIdentifier),
      spawn: (request) =>
        boundary.spawn({ ...request, executable: profile.helperPath }),
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const entry = catalog?.sources.length === 1 ? catalog.sources[0] : undefined
    if (!entry) return undefined
    const args = witnessArguments(entry.identity)
    const preflight = yield* readJson([profile.preflightFlag, ...args]).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(Preflight)(value).pipe(
          Effect.mapError(() => helperError()),
        ),
      ),
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (!preflight) return undefined
    return [
      ...args,
      "--application-id",
      String(preflight.identity.processIdentifier),
      "--application-launch",
      preflight.identity.launchIdentity,
      "--application-executable",
      preflight.identity.executableIdentity,
    ]
  })

export const inspectApplicationDiscovery =
  makeBoundedProbeInspector<ApplicationSummary>({
    helperPath: applicationDiscovery.helperPath,
    helperIdentifier: applicationDiscovery.helperIdentifier,
    metadataFlags: ["--list-kaset-sources", applicationDiscovery.preflightFlag],
    protectedFlag: applicationDiscovery.nativeFlag,
    operationTimeout: "8 seconds",
    prepare: prepareApplicationArguments(applicationDiscovery),
    decode: (value) =>
      Schema.decodeUnknownEffect(ApplicationSummary)(value).pipe(
        Effect.mapError(() => helperError()),
        Effect.map((decoded) => ({
          event: decoded.event,
          scope: decoded.scope,
          applicationChecks: decoded.applicationChecks,
          witnessChecks: decoded.witnessChecks,
          matchingApplications: decoded.matchingApplications,
          witnessMatches: decoded.witnessMatches,
          displayCount: decoded.displayCount,
        })),
      ),
  })
