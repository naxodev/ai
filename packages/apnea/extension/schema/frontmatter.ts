import { Result, Schema } from "effect"
import { isCompleteArtifact } from "../domain/frontmatter.ts"
import {
  stepAfterArtifact,
  type DispatchKind,
} from "../domain/state-machine.ts"
import type { FrontMatter, ReworkTarget, Step } from "../domain/types.ts"
import { ArtifactInvalid } from "../errors.ts"

const VerdictSchema = Schema.Literals(["APPROVED", "CHANGES_REQUIRED"] as const)
const ReworkTargetSchema = Schema.Literals(["code", "phase_package"] as const)

/**
 * Schema for the parsed front-matter result shape (after the line parser).
 * Consumed by wait in Phase 4.
 */
export const FrontMatterResultSchema = Schema.Struct({
  status: Schema.String,
  verdict: Schema.optional(VerdictSchema),
  nits: Schema.optional(Schema.String),
  rework: Schema.optional(ReworkTargetSchema),
})

export type FrontMatterResult = typeof FrontMatterResultSchema.Type

export type AcceptedArtifactCompletion = {
  frontmatter: FrontMatterResult
  next: Step
  rework: ReworkTarget | undefined
}

export function decodeFrontMatterResult(
  raw: unknown,
  artifact = "artifact",
): Result.Result<FrontMatterResult, ArtifactInvalid> {
  const decoded = Schema.decodeUnknownResult(FrontMatterResultSchema)(raw)
  if (Result.isFailure(decoded)) {
    return Result.fail(
      new ArtifactInvalid({
        artifact,
        message: decoded.failure.message,
      }),
    )
  }
  return Result.succeed(decoded.success)
}

/** Shared acceptance boundary for wait advancement and redelivery refusal. */
export function validateArtifactCompletion(
  kind: DispatchKind,
  fm: FrontMatter | null,
  artifact = "artifact",
): Result.Result<AcceptedArtifactCompletion | null, ArtifactInvalid> {
  const requireVerdict = kind === "plan_review" || kind === "code_review"
  if (!isCompleteArtifact(fm, { requireVerdict })) return Result.succeed(null)

  if (
    fm!.rework !== undefined &&
    (kind !== "code_review" || fm!.verdict !== "CHANGES_REQUIRED")
  ) {
    return Result.fail(
      new ArtifactInvalid({
        artifact,
        message:
          "rework is valid only on a code_review artifact with verdict CHANGES_REQUIRED",
      }),
    )
  }

  const decoded = decodeFrontMatterResult(
    {
      status: fm!.status,
      ...(requireVerdict ? { verdict: fm!.verdict } : {}),
      nits: fm!.nits,
      ...(kind === "code_review" && fm!.rework ? { rework: fm!.rework } : {}),
    },
    artifact,
  )
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure)

  const rework = kind === "code_review" ? decoded.success.rework : undefined
  const next = stepAfterArtifact(kind, fm!.verdict, rework)
  if (typeof next === "object") {
    return Result.fail(new ArtifactInvalid({ artifact, message: next.error }))
  }
  return Result.succeed({
    frontmatter: decoded.success,
    next,
    rework,
  })
}
