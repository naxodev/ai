import { Result, Schema } from "effect"
import { StateCorrupt } from "../errors.ts"
import {
  LEGACY_CODE_REWORK,
  LEGACY_PLAN_REWORK,
  type RequiredReworkTarget,
  type RunState,
  type Step,
} from "../domain/types.ts"

export const StepSchema = Schema.Literals([
  "planning",
  "plan_review",
  "phase_packaging",
  "coding",
  "code_review",
  "committing",
  "finishing",
  "done",
] as const)

export const VcsBackendSchema = Schema.Literals(["jj", "git"] as const)

export const RoleSchema = Schema.Literals([
  "orchestrator",
  "planner",
  "reviewer",
  "coder",
] as const)

export const RequiredReworkSchema = Schema.NullOr(
  Schema.Literals(["plan", "code", "phase_package"] as const),
)

export const PendingDeliverySchema = Schema.NullOr(
  Schema.Literals(["manual", "interactive"] as const),
)

const PaneRefSchema = Schema.Struct({
  pane_id: Schema.String,
  label: Schema.String,
  profile_fingerprint: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const PositiveSafeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonNegativeSafeInteger = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
)

const PendingCommitFields = {
  id: Schema.String.check(Schema.isMinLength(1)),
  phase_index: PositiveSafeInteger,
  message: Schema.String.check(Schema.isMinLength(1)),
  no_remaining_phases: Schema.Boolean,
  verify_log: Schema.String.check(Schema.isMinLength(1)),
}

// Anchor fields flow into git/jj argv, so they get format checks beyond
// minLength. Exploiting a loose anchor requires state.json write access
// (game-over elsewhere), but validating costs nothing and removes the class.
export const GitPendingCommitSchema = Schema.Struct({
  backend: Schema.Literal("git"),
  ...PendingCommitFields,
  branch: Schema.String.check(
    Schema.isPattern(/^refs\/heads\/apnea\/[A-Za-z0-9._-]+$/),
  ),
  parent_commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
  tree_id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
})

export const JjPendingCommitSchema = Schema.Struct({
  backend: Schema.Literal("jj"),
  ...PendingCommitFields,
  change_id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{1,32}$/)),
  content_fingerprint: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8,64}$/),
  ),
})

export const PendingCommitSchema = Schema.Union([
  GitPendingCommitSchema,
  JjPendingCommitSchema,
])

/**
 * Runtime codec for `state.json`.
 *
 * Input accepts version 1 (files written by 0.2.x) and version 2. Version-1
 * files must not carry `pending_commit` — that is enforced in
 * `decodeRunState`, which migrates every decoded state to version 2 with
 * `pending_commit: null`. Version-2 files must record `pending_commit`
 * explicitly, so a truncated or hand-edited v2 file fails closed instead of
 * silently losing a durable commit transaction.
 */
export const RunStateSchema = Schema.Struct({
  // v1 on Encoded so legacy files still decode; decodeRunState always
  // outputs version 2.
  version: Schema.Union([Schema.Literal(1), Schema.Literal(2)]),
  run_id: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    ),
  ),
  acquired_panes: Schema.optionalKey(Schema.Array(PaneRefSchema)),
  slug: Schema.String.check(Schema.isMinLength(1)),
  step: StepSchema,
  phase_index: PositiveSafeInteger,
  phase_count_hint: Schema.NullOr(NonNegativeSafeInteger),
  rounds: Schema.Record(Schema.String, PositiveSafeInteger),
  vcs: VcsBackendSchema,
  allow_dirty: Schema.Boolean,
  goal: Schema.String,
  last_error: Schema.NullOr(Schema.String),
  pending_artifact: Schema.NullOr(Schema.String),
  pending_role: Schema.NullOr(RoleSchema),
  pending_delivery: Schema.optionalKey(PendingDeliverySchema),
  // optional on Encoded so legacy fixtures without pane fields still decode
  pending_pane_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pending_pane_label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pending_started_at: Schema.optionalKey(Schema.NullOr(NonNegativeSafeInteger)),
  pending_deadline_ms: Schema.optionalKey(
    Schema.NullOr(NonNegativeSafeInteger),
  ),
  pending_nudged_at: Schema.optionalKey(Schema.NullOr(NonNegativeSafeInteger)),
  pending_final_grace: Schema.optionalKey(Schema.Boolean),
  pending_extended: Schema.optionalKey(Schema.Boolean),
  role_panes: Schema.optionalKey(Schema.Record(Schema.String, PaneRefSchema)),
  package_root: Schema.String,
  reviewer_tree_fingerprint: Schema.NullOr(Schema.String),
  current_phase_package: Schema.NullOr(Schema.String),
  current_code_review: Schema.NullOr(Schema.String),
  required_rework: Schema.optionalKey(RequiredReworkSchema),
  // optional on Encoded so version-1 files without the key still decode;
  // presence rules per version are enforced in `decodeRunState`.
  pending_commit: Schema.optionalKey(Schema.NullOr(PendingCommitSchema)),
})

export type DecodedRunState = typeof RunStateSchema.Type

function isPersistedArtifactPath(value: string): boolean {
  if (
    !value.startsWith(".apnea/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false
  }
  return value
    .slice(".apnea/".length)
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..")
}

function hasMatchingPendingCoderDispatch(d: DecodedRunState): boolean {
  const phase = String(d.phase_index).padStart(2, "0")
  const round = d.rounds[`phase-${phase}/code_review`] ?? 1
  return (
    d.pending_role === "coder" &&
    d.pending_artifact ===
      `.apnea/${d.run_id ? `runs/${d.run_id}/` : ""}artifacts/phase-${phase}/round-${round}/coder-result.md`
  )
}

export function decodeRunState(
  json: unknown,
  path = "state.json",
): Result.Result<RunState, StateCorrupt> {
  if (
    json !== null &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    "pending_floating_exit" in json &&
    json.pending_floating_exit !== null
  ) {
    return Result.fail(
      new StateCorrupt({
        path,
        message:
          'this run has an active legacy floating dispatch, but floating dispatch was removed; dismiss or terminate the old popup first, then run `apnea abandon` and `apnea start "<goal>"`',
      }),
    )
  }

  const raw =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {}
  const hasRequiredRework = raw.required_rework !== undefined
  const hasPendingDelivery = raw.pending_delivery !== undefined
  const hasPendingCommit =
    "pending_commit" in raw && raw.pending_commit !== undefined
  const decoded = Schema.decodeUnknownResult(RunStateSchema)(json)
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new StateCorrupt({
        path,
        message: decoded.failure.message,
      }),
    )
  }
  const d = decoded.success
  // A version-1 writer never emits `pending_commit`; its presence means the
  // file was mixed across versions. Fail closed instead of guessing.
  if (d.version === 1 && hasPendingCommit) {
    return Result.fail(
      new StateCorrupt({
        path,
        message:
          "pending_commit requires state version 2; refusing version-1 file that carries it",
      }),
    )
  }
  if (d.version === 2 && !hasPendingCommit) {
    return Result.fail(
      new StateCorrupt({
        path,
        message:
          "version-2 state must record pending_commit explicitly; refusing file that omits it",
      }),
    )
  }
  if (
    d.pending_commit !== null &&
    d.pending_commit !== undefined &&
    d.step !== "committing"
  ) {
    return Result.fail(
      new StateCorrupt({
        path,
        message: `pending_commit requires step "committing", found "${d.step}"`,
      }),
    )
  }
  if (
    d.pending_commit != null &&
    d.pending_commit.phase_index !== d.phase_index
  ) {
    return Result.fail(
      new StateCorrupt({
        path,
        message: `pending_commit targets phase ${d.pending_commit.phase_index} but state is at phase ${d.phase_index}`,
      }),
    )
  }
  if (
    d.pending_commit != null &&
    !isPersistedArtifactPath(d.pending_commit.verify_log)
  ) {
    return Result.fail(
      new StateCorrupt({
        path,
        message:
          "pending_commit.verify_log must be a repository-relative .apnea/ path",
      }),
    )
  }
  for (const [field, value] of [
    ["pending_artifact", d.pending_artifact],
    ["current_phase_package", d.current_phase_package],
    ["current_code_review", d.current_code_review],
  ] as const) {
    if (value !== null && !isPersistedArtifactPath(value)) {
      return Result.fail(
        new StateCorrupt({
          path,
          message: `${field} must be a repository-relative .apnea/ path`,
        }),
      )
    }
  }
  // Backward-compat defaults for state.json files predating pane tracking.
  // Every decoded state migrates to version 2; the rewrite to disk happens
  // at the next normal save.
  const state: RunState = {
    version: 2,
    ...(d.run_id === undefined ? {} : { run_id: d.run_id }),
    ...(d.acquired_panes === undefined
      ? {}
      : {
          acquired_panes: d.acquired_panes.map((pane) => ({
            pane_id: pane.pane_id,
            label: pane.label,
          })),
        }),
    slug: d.slug,
    step: d.step as Step,
    phase_index: d.phase_index,
    phase_count_hint: d.phase_count_hint,
    rounds: { ...d.rounds },
    vcs: d.vcs,
    allow_dirty: d.allow_dirty,
    goal: d.goal,
    last_error: d.last_error,
    pending_artifact: d.pending_artifact,
    pending_role: d.pending_role,
    pending_delivery: hasPendingDelivery
      ? (d.pending_delivery ?? null)
      : d.pending_artifact !== null && d.pending_pane_id != null
        ? "interactive"
        : null,
    pending_pane_id: d.pending_pane_id ?? null,
    pending_pane_label: d.pending_pane_label ?? null,
    pending_started_at: d.pending_started_at ?? null,
    pending_deadline_ms: d.pending_deadline_ms ?? null,
    pending_nudged_at: d.pending_nudged_at ?? null,
    pending_final_grace: d.pending_final_grace ?? false,
    pending_extended: d.pending_extended ?? false,
    role_panes: Object.fromEntries(
      Object.entries(d.role_panes ?? {}).map(([role, pane]) => [
        role,
        { ...pane, profile_fingerprint: pane.profile_fingerprint ?? null },
      ]),
    ),
    package_root: d.package_root,
    reviewer_tree_fingerprint: d.reviewer_tree_fingerprint,
    current_phase_package: d.current_phase_package,
    current_code_review: d.current_code_review,
    required_rework: (hasRequiredRework
      ? d.required_rework
      : raw.phase_package_rework === true
        ? "phase_package"
        : null) as RequiredReworkTarget | null,
    pending_commit: d.pending_commit ?? null,
  }
  if (
    !hasRequiredRework &&
    state.required_rework === null &&
    d.step === "planning"
  ) {
    Object.defineProperty(state, LEGACY_PLAN_REWORK, { value: true })
  }
  if (
    !hasRequiredRework &&
    state.required_rework === null &&
    d.step === "coding" &&
    d.current_code_review !== null &&
    !hasMatchingPendingCoderDispatch(d)
  ) {
    Object.defineProperty(state, LEGACY_CODE_REWORK, { value: true })
  }
  return Result.succeed(state)
}

export type { Step }
