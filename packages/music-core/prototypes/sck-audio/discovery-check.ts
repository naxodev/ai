/** Bounded source inspection. This boundary rejects every capture command. */
import { Effect, Schema } from "effect"
import { helperError } from "../../audio/helper-process.ts"
import { readLocalKasetCatalog } from "../../audio/local-kaset.ts"
import {
  sckDependencies,
  sckHelperIdentifier,
  sckHelperPath,
} from "./adapter.ts"
import {
  makeDiscoveryInspector,
  type DiscoveryResult,
} from "./discovery-process.ts"
import { sourceDiscovery } from "./source-discovery.ts"

export const DiscoveryCount = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(65536),
)
const DiscoverySummary = Schema.Struct({
  event: Schema.Literal("sck-source-discovery"),
  identityChecks: Schema.Literal("passed-before-and-after"),
  attributionChecks: Schema.Literal("passed-before-and-after"),
  matchingApplications: DiscoveryCount,
  displayCount: DiscoveryCount,
})
interface DiscoverySummary extends Schema.Schema.Type<
  typeof DiscoverySummary
> {}
export type SourceDiscoveryResult = DiscoveryResult<DiscoverySummary>

export const witnessArguments = (identity: {
  processIdentifier: number
  launchIdentity: string
  executableIdentity: string
  coreAudioObject: string
}) => [
  "--protocol",
  "1",
  "--process-id",
  String(identity.processIdentifier),
  "--launch-identity",
  identity.launchIdentity,
  "--executable-identity",
  identity.executableIdentity,
  "--core-audio-object",
  identity.coreAudioObject,
  "--attribution",
  "kaset-cache-v1",
]

export const inspectSourceDiscovery = makeDiscoveryInspector<DiscoverySummary>({
  helperPath: sckHelperPath,
  helperIdentifier: sckHelperIdentifier,
  metadataFlags: ["--list-kaset-sources"],
  discoveryFlag: sourceDiscovery.nativeFlag,
  prepare: Effect.fn("SckDiscovery.prepareSource")(function* (boundary) {
    const catalog = yield* readLocalKasetCatalog(
      sckDependencies(boundary),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const entry = catalog?.sources.length === 1 ? catalog.sources[0] : undefined
    return entry ? witnessArguments(entry.identity) : undefined
  }),
  decode: (value) =>
    Schema.decodeUnknownEffect(DiscoverySummary)(value).pipe(
      Effect.mapError(() => helperError()),
      Effect.map((decoded) => ({
        event: decoded.event,
        identityChecks: decoded.identityChecks,
        attributionChecks: decoded.attributionChecks,
        matchingApplications: decoded.matchingApplications,
        displayCount: decoded.displayCount,
      })),
    ),
})
