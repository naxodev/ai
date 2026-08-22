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

/**
 * Runtime codec for `state.json` (version 1).
 * Missing pane-tracking fields are filled in `decodeRunState` (legacy files).
 */
export const RunStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  slug: Schema.String.check(Schema.isMinLength(1)),
  step: StepSchema,
  phase_index: Schema.Number,
  phase_count_hint: Schema.NullOr(Schema.Number),
  rounds: Schema.Record(Schema.String, Schema.Number),
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
  pending_started_at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  pending_deadline_ms: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  pending_nudged_at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  pending_final_grace: Schema.optionalKey(Schema.Boolean),
  pending_extended: Schema.optionalKey(Schema.Boolean),
  role_panes: Schema.optionalKey(Schema.Record(Schema.String, PaneRefSchema)),
  package_root: Schema.String,
  reviewer_tree_fingerprint: Schema.NullOr(Schema.String),
  current_phase_package: Schema.NullOr(Schema.String),
  current_code_review: Schema.NullOr(Schema.String),
  required_rework: Schema.optionalKey(RequiredReworkSchema),
})

export type DecodedRunState = typeof RunStateSchema.Type

function hasMatchingPendingCoderDispatch(d: DecodedRunState): boolean {
  const phase = String(d.phase_index).padStart(2, "0")
  const round = d.rounds[`phase-${phase}/code_review`] ?? 1
  return (
    d.pending_role === "coder" &&
    d.pending_artifact ===
      `.apnea/artifacts/phase-${phase}/round-${round}/coder-result.md`
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
  // Backward-compat defaults for state.json files predating pane tracking.
  const state: RunState = {
    version: 1,
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
