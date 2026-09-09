import * as path from "node:path"
import { Effect, Result } from "effect"
import { asVerdict, parseFrontMatter } from "../domain/frontmatter.ts"
import { abs, phaseDir, rel } from "../domain/paths.ts"
import { nextAfter, toolAllowed } from "../domain/state-machine.ts"
import {
  extractVerifyBlocks,
  formatVerifyCommand,
} from "../domain/verify-commands.ts"
import {
  ArtifactInvalid,
  GateRefused,
  VerifyFailed,
  type AppError,
} from "../errors.ts"
import { ok, type ToolResult } from "../result.ts"
import { Config } from "../services/config.ts"
import { FileSystem } from "../services/file-system.ts"
import { RunStore, type RunStoreService } from "../services/run-store.ts"
import {
  Vcs,
  type VcsService,
  withTransactionTrailer,
  withoutTransactionTrailer,
} from "../services/vcs.ts"
import type { RunState } from "../domain/types.ts"

export type CommitParams = {
  message?: string
  /** When true and no more phases, advance to finishing instead of phase_packaging */
  no_remaining_phases?: boolean
}

/**
 * Require APPROVED code review, run phase package verify commands,
 * jj/git commit, advance phase. Refusals are tagged failures only.
 *
 * The commit itself is a crash-recoverable transaction:
 *
 *   gates → verify.log → prepare → save pending_commit (durable point)
 *   → complete or recognize → bookmark (jj, final phase) → advance + clear
 *
 * Once `pending_commit` is saved, cancellation does NOT undo the
 * transaction — the prepared anchor is durable and a later commit call
 * resumes or recognizes it. A call that loads an existing `pending_commit`
 * skips the gates and verification entirely and resumes only that
 * transaction; retry params conflicting with the persisted message or
 * `--done` value are refused, not silently ignored.
 */
export const commitWorkflow = (
  params: CommitParams,
  root: string,
): Effect.Effect<ToolResult, AppError, FileSystem | RunStore | Config | Vcs> =>
  Effect.gen(function* () {
    const store = yield* RunStore
    const fs = yield* FileSystem
    const config = yield* Config
    const vcs = yield* Vcs

    const state = yield* store.require(root)

    const allowed = toolAllowed(state.step, "workflow_commit_phase")
    if (Result.isFailure(allowed)) {
      return yield* allowed.failure
    }

    if (state.pending_commit) {
      return yield* resumePendingCommit({
        params,
        root,
        state,
        store,
        vcs,
      })
    }

    const reviewRel = state.current_code_review
    if (!reviewRel) {
      return yield* new GateRefused({
        gate: "commit",
        message: "current_code_review not set — complete code_review first",
      })
    }

    const reviewAbs = abs(reviewRel, root)
    const reviewPresent = yield* fs.projectPathExists(root, reviewAbs)
    let fm: ReturnType<typeof parseFrontMatter> = null
    if (reviewPresent) {
      const reviewText = yield* fs.readProjectFile(root, reviewAbs).pipe(
        Effect.mapError(
          (error) =>
            new ArtifactInvalid({
              artifact: reviewRel,
              message: error.message,
            }),
        ),
      )
      fm = parseFrontMatter(reviewText)
    }
    const verdict = asVerdict(fm?.verdict)
    if (verdict !== "APPROVED") {
      return yield* new GateRefused({
        gate: "commit",
        message: `commit refused: code review verdict is ${fm?.verdict ?? "missing"} (need APPROVED)`,
        details: {
          review: reviewRel,
          verdict: fm?.verdict ?? "missing",
        },
      })
    }

    const pkgRel =
      state.current_phase_package ??
      rel(
        path.join(
          phaseDir(state.phase_index, 1, root, state.run_id),
          "phase-package.md",
        ),
        root,
      )
    const pkgAbs = abs(pkgRel, root)
    const pkgPresent = yield* fs.projectPathExists(root, pkgAbs)
    if (!pkgPresent) {
      return yield* new GateRefused({
        gate: "commit",
        message: `phase package missing: ${pkgRel}`,
        details: { package: pkgRel },
      })
    }
    const pkgText = yield* fs
      .readProjectFile(root, pkgAbs)
      .pipe(
        Effect.mapError(
          (error) =>
            new ArtifactInvalid({ artifact: pkgRel, message: error.message }),
        ),
      )
    const blocks = extractVerifyBlocks(pkgText)
    if (!blocks.length) {
      return yield* new ArtifactInvalid({
        artifact: pkgRel,
        message: "no verify commands found in phase package (need ```sh block)",
      })
    }

    const cfg = yield* config.load(root)
    const verifyTimeout = cfg.timeouts_ms.verify ?? 900_000
    const verify = yield* vcs.runVerify(root, blocks, verifyTimeout)

    const vlog = path.join(path.dirname(reviewAbs), "verify.log")
    yield* fs.writeProjectFile(root, vlog, `${verify.log}\n`)

    if (!verify.ok) {
      return yield* new VerifyFailed({
        commands: blocks.map(formatVerifyCommand),
        outputs: [verify.log.slice(-2000)],
        // `outputs` is a tail — point the caller at the full log on disk.
        verify_log: rel(vlog, root),
      })
    }

    const message =
      params.message?.trim() ||
      `feat: apnea phase ${state.phase_index} (${state.slug})`

    const prepared = yield* vcs.prepareCommit(root, state.vcs, message)

    // Durable point. From here the transaction survives crashes and
    // cancellation: the anchor below is everything completion needs to
    // recognize or create the commit exactly once.
    const noRemainingPhases = params.no_remaining_phases === true
    const verifyLogRel = rel(vlog, root)
    state.pending_commit =
      prepared.backend === "git"
        ? {
            id: prepared.id,
            backend: prepared.backend,
            phase_index: state.phase_index,
            message: prepared.message,
            no_remaining_phases: noRemainingPhases,
            verify_log: verifyLogRel,
            branch: prepared.branch,
            parent_commit: prepared.parent_commit,
            tree_id: prepared.tree_id,
          }
        : {
            id: prepared.id,
            backend: prepared.backend,
            phase_index: state.phase_index,
            message: prepared.message,
            no_remaining_phases: noRemainingPhases,
            verify_log: verifyLogRel,
            change_id: prepared.change_id,
            content_fingerprint: prepared.content_fingerprint,
          }
    yield* store.save(state, root)

    const committedId = yield* vcs.completeCommit(
      root,
      state.vcs,
      state.pending_commit,
    )

    return yield* advanceAndSave({
      state,
      store,
      vcs,
      root,
      noRemainingPhases,
      committedId,
      recovered: false,
      transactionId: state.pending_commit.id,
      verifyLog: verifyLogRel,
    })
  })

type ResumeArgs = {
  params: CommitParams
  root: string
  state: RunState
  store: RunStoreService
  vcs: VcsService
}

/**
 * Resume the durable transaction only: no gates, no verification.
 * Explicit retry params conflicting with the persisted values are refused.
 */
function resumePendingCommit({
  params,
  root,
  state,
  store,
  vcs,
}: ResumeArgs): Effect.Effect<ToolResult, AppError> {
  return Effect.gen(function* () {
    const pending = state.pending_commit!
    const requestedMessage = params.message?.trim()
    // Compare against the exact trailer-augmented form the transaction will
    // write, not a stripped persisted message: stripping only removes the
    // LAST trailer line, so a user message that legitimately ends with a
    // trailer-shaped line would otherwise refuse an identical plain retry.
    if (
      requestedMessage !== undefined &&
      requestedMessage !== pending.message &&
      withTransactionTrailer(requestedMessage, pending.id) !== pending.message
    ) {
      return yield* new GateRefused({
        gate: "commit",
        message:
          "conflicting retry: this call already has a durable commit transaction with a different message",
        details: {
          transaction: pending.id,
          persisted_message: withoutTransactionTrailer(pending.message),
          requested_message: requestedMessage,
        },
      })
    }
    if (
      params.no_remaining_phases !== undefined &&
      params.no_remaining_phases !== pending.no_remaining_phases
    ) {
      return yield* new GateRefused({
        gate: "commit",
        message:
          "conflicting retry: this call already has a durable commit transaction with a different no_remaining_phases value",
        details: {
          transaction: pending.id,
          persisted_no_remaining_phases: pending.no_remaining_phases,
          requested_no_remaining_phases: params.no_remaining_phases,
        },
      })
    }

    const committedId = yield* vcs.completeCommit(root, state.vcs, pending)

    return yield* advanceAndSave({
      state,
      store,
      vcs,
      root,
      noRemainingPhases: pending.no_remaining_phases,
      committedId,
      recovered: true,
      transactionId: pending.id,
      verifyLog: pending.verify_log,
    })
  })
}

type AdvanceArgs = {
  state: RunState
  store: RunStoreService
  vcs: VcsService
  root: string
  noRemainingPhases: boolean
  committedId: string
  recovered: boolean
  transactionId: string
  /** Repo-relative verify.log path captured before the phase advanced. */
  verifyLog: string
}

/**
 * Advance the run after completion. A bookmark failure propagates BEFORE any
 * state mutation is saved, so `pending_commit` stays durable and the
 * transaction remains resumable on the next call.
 */
function advanceAndSave({
  state,
  store,
  vcs,
  root,
  noRemainingPhases,
  committedId,
  recovered,
  transactionId,
  verifyLog,
}: AdvanceArgs): Effect.Effect<ToolResult, AppError> {
  return Effect.gen(function* () {
    if (noRemainingPhases) {
      state.step = "finishing"
      if (state.vcs === "jj") {
        yield* vcs.setBookmarkAtTerminus(root, state.slug)
      }
    } else {
      state.phase_index += 1
      state.step = "phase_packaging"
      state.current_phase_package = null
      state.current_code_review = null
    }
    state.last_error = null
    state.pending_commit = null
    yield* store.save(state, root)

    const prefix = recovered
      ? `committed phase (recovered transaction ${transactionId})`
      : "committed phase"
    return ok(
      `${prefix}; step → ${state.step}`,
      {
        vcs_detail: `${state.vcs} commit ${committedId}`,
        transaction: transactionId,
        verify_log: verifyLog,
        step: state.step,
        phase_index: state.phase_index,
        next:
          state.step === "finishing"
            ? ["dispatch_role kind=pr_description"]
            : ["dispatch_role kind=phase_package"],
      },
      nextAfter(state.step),
    )
  })
}
