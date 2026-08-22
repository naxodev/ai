import * as path from "node:path"
import { Cause, Clock, Effect, Exit, Result } from "effect"
import {
  packageRoot,
  phaseDir,
  planPath,
  planReviewPath,
  prDescriptionPath,
  rel,
  tasksDir,
} from "../domain/paths.ts"
import { resetRecoveryLadder } from "../domain/recovery.ts"
import { getRound, roundKey, setRound } from "../domain/rounds.ts"
import {
  allowedKinds,
  expectedRole,
  toolAllowed,
  type DispatchKind,
} from "../domain/state-machine.ts"
import { timeoutMsForKind } from "../domain/timeouts.ts"
import {
  GateRefused,
  HerdrError,
  IllegalKind,
  type AppError,
} from "../errors.ts"
import type { Role } from "../domain/types.ts"
import { ROLE_MODE } from "../domain/types.ts"
import { ok, type ToolResult } from "../result.ts"
import { Config } from "../services/config.ts"
import { FileSystem } from "../services/file-system.ts"
import { Herdr } from "../services/herdr.ts"
import { RunStore } from "../services/run-store.ts"
import { Vcs } from "../services/vcs.ts"

export type DispatchParams = {
  kind: DispatchKind
  task_markdown?: string
  /** Increment round after CHANGES_REQUIRED (protocol: only then). */
  rework?: boolean
}

function taskBody(opts: {
  kind: DispatchKind
  role: Role
  goal: string
  artifactRel: string
  briefAbs: string
  extra: string
}): string {
  return `# Dispatch: ${opts.role} (${opts.kind})

## Role

${opts.role}

## Brief

Read and follow:

\`${opts.briefAbs}\`

## Goal

${opts.goal}

## Artifact

Write **exactly**:

\`${opts.artifactRel}\`

Front-matter must include \`status: done\`. Review artifacts also need \`verdict: APPROVED | CHANGES_REQUIRED\` and optional \`nits\`. A code-review \`CHANGES_REQUIRED\` may use \`rework: code | phase_package\`; absent means code.

## Details

${opts.extra}

## Rules

- Do not invent artifact paths.
- Do not edit \`.apnea/state.json\`.
- Do not commit / push.
`
}

function codeReviewRoundKey(phaseIndex: number): string {
  return roundKey(phaseIndex, "code_review")
}

function herdrAfterRollback(
  e: HerdrError,
  context: { readonly task_attempted: string; readonly artifact: string },
  rollbackErrors: readonly string[],
): HerdrError {
  return new HerdrError({
    message: e.message,
    ...(e.command !== undefined ? { command: e.command } : {}),
    details: {
      ...(e.details ?? {}),
      ...context,
      rolled_back: rollbackErrors.length === 0,
      ...(rollbackErrors.length > 0
        ? { rollback_errors: [...rollbackErrors] }
        : {}),
    },
  })
}

/**
 * Write task file, open an interactive harness TUI in a reusable Herdr pane,
 * wait until idle, then submit a short pointer prompt.
 * Refusals are tagged failures only — never ok:false ToolResults.
 */
export const dispatchWorkflow = (
  params: DispatchParams,
  root: string,
  // `packageRoot` override for tests. The real resolver reads the actual
  // filesystem with node:fs — below the FileSystem service every other file
  // access here goes through — so without this seam the stale-root tests had
  // to seed the fake filesystem at a path derived from wherever the suite
  // happened to run.
  opts: { packageRoot?: () => string } = {},
): Effect.Effect<
  ToolResult,
  AppError,
  FileSystem | RunStore | Config | Vcs | Herdr
> =>
  Effect.gen(function* () {
    const store = yield* RunStore
    const fs = yield* FileSystem
    const config = yield* Config
    const vcsSvc = yield* Vcs
    const herdr = yield* Herdr

    const state = yield* store.require(root)
    const stateBeforeDispatch = structuredClone(state)

    const allowed = toolAllowed(state.step, "dispatch_role")
    if (Result.isFailure(allowed)) {
      return yield* allowed.failure
    }

    if (state.pending_artifact != null) {
      return yield* new GateRefused({
        gate: "dispatch_pending",
        message:
          "a role dispatch is already pending; call workflow_wait before dispatching again",
        details: {
          pending_artifact: state.pending_artifact,
          pending_role: state.pending_role,
          pending_pane_id: state.pending_pane_id,
        },
      })
    }

    const kinds = allowedKinds(state.step)
    if (!kinds.includes(params.kind)) {
      return yield* new IllegalKind({
        step: state.step,
        kind: params.kind,
        allowed: kinds,
      })
    }

    // Rework flag validation
    if (params.rework) {
      const okRework =
        (params.kind === "plan" && state.step === "planning") ||
        (params.kind === "code" && state.step === "coding") ||
        (params.kind === "phase_package" &&
          state.step === "phase_packaging" &&
          state.phase_package_rework) ||
        (params.kind === "plan_review" && state.step === "plan_review") ||
        (params.kind === "code_review" && state.step === "code_review")
      // After CHANGES_REQUIRED, step moves back to planning/coding; rework
      // dispatch is plan/code with rework=true.
      if (!okRework && !(params.kind === "plan" || params.kind === "code")) {
        return yield* new GateRefused({
          gate: "rework",
          message:
            "rework=true only valid for plan/code after CHANGES_REQUIRED, phase_package after package rework, or same-gate re-review",
        })
      }
    }

    const role = expectedRole(params.kind)
    const cfg = yield* config.load(root)
    const roleTimeoutMs = timeoutMsForKind(params.kind, cfg.timeouts_ms)
    // Validate the orchestrator's current pane before creating task artifacts.
    // A stale inherited environment is equivalent to running outside Herdr;
    // other CLI failures remain typed errors and stop dispatch.
    const herdrAvailability = yield* herdr.availability

    // --- Round numbers (increment ONLY on rework after CHANGES_REQUIRED) ---
    let round = 1
    if (params.kind === "plan" || params.kind === "plan_review") {
      const key = roundKey(0, "plan_review")
      if (params.rework && params.kind === "plan") {
        // starting a new plan revision after CHANGES_REQUIRED → next review round
        setRound(state, key, getRound(state, key) + 1)
      } else if (!state.rounds[key]) {
        setRound(state, key, 1)
      }
      round = getRound(state, key)
    } else if (
      params.kind === "code" ||
      params.kind === "code_review" ||
      params.kind === "phase_package"
    ) {
      const key = codeReviewRoundKey(state.phase_index)
      if (params.rework && params.kind === "code") {
        setRound(state, key, getRound(state, key) + 1)
      } else if (
        params.kind === "phase_package" &&
        state.phase_package_rework
      ) {
        setRound(state, key, getRound(state, key) + 1)
      } else if (!state.rounds[key]) {
        setRound(state, key, 1)
      }
      round = getRound(state, key)
    }

    // Cap: number of review rounds (rework count)
    const capKey =
      params.kind === "plan" || params.kind === "plan_review"
        ? roundKey(0, "plan_review")
        : codeReviewRoundKey(state.phase_index)
    if (
      (params.kind === "plan" ||
        params.kind === "code" ||
        params.kind === "phase_package" ||
        params.kind === "plan_review" ||
        params.kind === "code_review") &&
      getRound(state, capKey) > cfg.review_round_cap
    ) {
      return yield* new GateRefused({
        gate: "round_cap",
        message: `review round cap ${cfg.review_round_cap} exceeded for ${capKey}. Human: apnea reset-rounds ${capKey} (or /apnea reset-rounds ${capKey}).`,
        details: { gate_key: capKey, cap: cfg.review_round_cap },
      })
    }

    // Resolve artifact path
    let artifactAbs: string
    let extra = params.task_markdown?.trim() || ""

    switch (params.kind) {
      case "plan":
        artifactAbs = planPath(root)
        if (!extra) {
          extra = `Produce full plan for goal. Vertical phases with acceptance + verify commands.\nIf rework, address plan-review under .apnea/artifacts/plan-review/.`
        }
        break
      case "plan_review":
        artifactAbs = planReviewPath(round, root)
        extra =
          extra ||
          `Review plan at \`${rel(planPath(root), root)}\`.\nWrite verdict front-matter.`
        break
      case "phase_package": {
        const d = phaseDir(state.phase_index, round, root)
        artifactAbs = path.join(d, "phase-package.md")
        extra =
          extra ||
          (state.phase_package_rework
            ? `Revise the phase ${state.phase_index} package after code review \`${state.current_code_review}\`. Preserve approved-plan scope and address package findings.`
            : `Emit phase package for phase ${state.phase_index} only from approved plan \`${rel(planPath(root), root)}\`.`)
        break
      }
      case "code": {
        const d = phaseDir(state.phase_index, round, root)
        artifactAbs = path.join(d, "coder-result.md")
        const pkg =
          state.current_phase_package ??
          rel(
            path.join(phaseDir(state.phase_index, 1, root), "phase-package.md"),
            root,
          )
        extra =
          extra ||
          `Implement phase package \`${pkg}\` only.\nOn rework, read latest code-review and fix.`
        break
      }
      case "code_review": {
        const d = phaseDir(state.phase_index, round, root)
        artifactAbs = path.join(d, "code-review.md")
        const pkg =
          state.current_phase_package ??
          rel(
            path.join(phaseDir(state.phase_index, 1, root), "phase-package.md"),
            root,
          )
        const coder = rel(path.join(d, "coder-result.md"), root)
        extra =
          extra ||
          `1) Compare phase package \`${pkg}\` to plan.\n2) Review code vs package.\n3) Check coder result \`${coder}\`.`
        break
      }
      case "pr_description":
        artifactAbs = prDescriptionPath(root)
        extra = extra || "Write PR description summarizing all phases."
        break
    }

    // Resolve the brief BEFORE clear-before-dispatch. This block can refuse,
    // and the rename below is a mutation: refusing after it left the prior
    // artifact stranded at a timestamped .bak path, so a failed dispatch
    // quietly destroyed the artifact it was supposed to replace.
    //
    // The run's pinned root (stamped into state.json at `start`) comes
    // FIRST. A run must keep the brief version it started with — the live
    // install can be a newer checkout whose briefs describe a different
    // artifact layout, and silently swapping mid-run points the role's
    // instructions at one protocol while the run's gates expect another.
    // The live root is strictly a repair path: it is consulted only when
    // the pinned root has no brief at all, which is what a run stamped by
    // the broken bundled resolver looks like.
    const livePackageRoot = opts.packageRoot?.() ?? packageRoot()
    const briefCandidates = [
      ...new Set([
        path.join(state.package_root, "briefs", `${role}.md`),
        path.join(livePackageRoot, "briefs", `${role}.md`),
      ]),
    ]
    let briefAbs: string | null = null
    for (const candidate of briefCandidates) {
      if (yield* fs.exists(candidate)) {
        briefAbs = candidate
        break
      }
    }
    if (briefAbs == null) {
      // Refuse loudly here rather than launching a pane whose role will
      // stall on a missing file with no diagnostic from apnea.
      return yield* new GateRefused({
        gate: "brief",
        message:
          `no brief for role "${role}". Looked in ${briefCandidates.join(" and ")}. ` +
          `The package root could not be resolved — reinstall @naxodev/apnea, or start a fresh run if this one predates a move.`,
        details: { role, tried: briefCandidates },
      })
    }

    // Resolve the interactive command before mutating artifacts. Apnea never
    // falls back to a profile's oneshot command, even outside Herdr.
    const roleCmd = yield* config.resolveRoleCmd(cfg, role, "interactive")
    const profileFingerprint = JSON.stringify([
      cfg.roles[role]?.profile ?? null,
      roleCmd,
    ])

    if (role === "reviewer") {
      state.reviewer_tree_fingerprint = yield* vcsSvc.treeFingerprint(
        root,
        state.vcs,
      )
    }

    // clear-before-dispatch
    yield* fs.mkdirProject(root, path.dirname(artifactAbs))
    let backupAbs: string | null = null
    if (yield* fs.projectPathExists(root, artifactAbs)) {
      const backupMillis = yield* Clock.currentTimeMillis
      backupAbs = `${artifactAbs}.bak.${backupMillis}`
      yield* fs.renameProjectFile(root, artifactAbs, backupAbs)
    }

    const artifactRel = rel(artifactAbs, root)
    const body = taskBody({
      kind: params.kind,
      role,
      goal: state.goal,
      artifactRel,
      briefAbs,
      extra,
    })

    let taskFileMillis = yield* Clock.currentTimeMillis
    let taskFile = path.join(
      tasksDir(root),
      `${params.kind}-p${state.phase_index}-r${round}-${taskFileMillis}.md`,
    )
    while (yield* fs.projectPathExists(root, taskFile)) {
      taskFileMillis += 1
      taskFile = path.join(
        tasksDir(root),
        `${params.kind}-p${state.phase_index}-r${round}-${taskFileMillis}.md`,
      )
    }
    yield* fs.writeProjectFile(root, taskFile, body)
    const taskRef = {
      task: rel(taskFile, root),
      artifact: artifactRel,
    }

    const prompt = [
      `You are the ${role}.`,
      `Read brief: ${briefAbs}`,
      `Read task: ${rel(taskFile, root)}`,
      `Write artifact exactly at: ${artifactRel}`,
      "Follow the brief. Do not invent paths. Do not commit. Do not edit .apnea/state.json.",
    ].join("\n")

    let launch: Record<string, unknown> = {
      mode: ROLE_MODE[role],
    }

    const rollbackLaunch = (restoreState = true) =>
      Effect.gen(function* () {
        const errors: string[] = []
        const attempt = (
          label: string,
          operation: Effect.Effect<void, unknown>,
        ) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(operation)
            if (Exit.isFailure(exit)) {
              errors.push(`${label}: ${Cause.pretty(exit.cause)}`)
            }
          })
        yield* attempt("remove task", fs.removeProjectFile(root, taskFile))
        yield* attempt(
          "remove replacement artifact",
          fs.removeProjectFile(root, artifactAbs),
        )
        if (backupAbs != null) {
          yield* attempt(
            "restore prior artifact",
            fs.renameProjectFile(root, backupAbs, artifactAbs),
          )
        }
        if (restoreState) {
          yield* attempt(
            "restore workflow state",
            store.save(stateBeforeDispatch, root),
          )
        }
        return errors
      })

    const markPending = (launchedAt: number): void => {
      state.pending_artifact = artifactRel
      state.pending_role = role
      state.pending_started_at = launchedAt
      state.pending_deadline_ms = launchedAt + roleTimeoutMs
      if (params.kind === "phase_package") state.phase_package_rework = false
      resetRecoveryLadder(state)
    }

    // Persist ownership before crossing an external launch boundary. If this
    // process dies after Herdr accepts work, a retry must not start a duplicate.
    const preparedAt = yield* Clock.currentTimeMillis
    markPending(preparedAt)
    state.pending_pane_id = null
    state.pending_pane_label = null
    const preparedState = yield* Effect.exit(store.save(state, root))
    if (Exit.isFailure(preparedState)) {
      const persistenceError = new HerdrError({
        message: `failed to persist pending dispatch before launch: ${Cause.pretty(preparedState.cause)}`,
      })
      const rollbackErrors = yield* rollbackLaunch(false)
      return yield* herdrAfterRollback(
        persistenceError,
        {
          task_attempted: taskRef.task,
          artifact: artifactRel,
        },
        rollbackErrors,
      )
    }

    if (herdrAvailability === "unavailable") {
      // Stamped here, not at the top of the workflow: `pending_started_at` is
      // the anchor for both the role's deadline and wait's liveness grace, so
      // it must mean "the role has the prompt", not "dispatch began".
      return ok(
        `task written (no Herdr). Launch ${role} yourself; then workflow_wait.`,
        {
          task: taskRef.task,
          artifact: artifactRel,
          round,
          step: state.step,
          launch,
          next: "workflow_wait",
        },
        // Not `nextAfter(state.step)`: a dispatch is now outstanding, and
        // `nextAfter` is step-derived so it cannot know that. Advertising
        // `dispatch_role` here would invite a second dispatch that orphans
        // this one's in-flight work and resets its deadline.
        ["workflow_wait"],
      )
    }

    // Interactive TUI: open harness, wait idle, submit pointer via pane run.
    const cmd = roleCmd
    const remembered = state.role_panes[role] ?? null
    const prefer =
      remembered?.profile_fingerprint === profileFingerprint ? remembered : null
    const launched = yield* Effect.result(
      herdr.runInteractivePrompt(role, cmd, prompt, prefer),
    )
    if (Result.isFailure(launched)) {
      if (launched.failure.details?.delivery === "unknown") {
        const paneId = String(launched.failure.details.pane_id)
        const paneLabel = String(launched.failure.details.pane_label)
        state.pending_pane_id = paneId
        state.pending_pane_label = paneLabel
        state.role_panes[role] = {
          pane_id: paneId,
          label: paneLabel,
          profile_fingerprint: profileFingerprint,
        }
        yield* store.save(state, root)
        return yield* new HerdrError({
          message: launched.failure.message,
          ...(launched.failure.command !== undefined
            ? { command: launched.failure.command }
            : {}),
          details: {
            ...(launched.failure.details ?? {}),
            task_attempted: taskRef.task,
            artifact: artifactRel,
            pending_preserved: true,
          },
        })
      }
      const rollbackErrors = yield* rollbackLaunch()
      return yield* herdrAfterRollback(
        launched.failure,
        {
          task_attempted: taskRef.task,
          artifact: artifactRel,
        },
        rollbackErrors,
      )
    }
    const r = launched.success
    launch = {
      mode: "interactive",
      pane_id: r.pane_id,
      label: r.label,
      reused: r.reused,
      cmd,
      prompt,
      prompt_accepted: r.prompt_accepted,
      prompt_attempts: r.prompt_attempts,
      last_status: r.last_status ?? null,
    }
    state.pending_pane_id = r.pane_id
    state.pending_pane_label = r.label
    state.role_panes[role] = {
      pane_id: r.pane_id,
      label: r.label,
      profile_fingerprint: profileFingerprint,
    }

    // After the launch, not before it: `runInteractivePrompt` blocks in
    // `waitAgentReady` (up to 90s) plus prompt-submit retries. Anchoring at
    // the top of the workflow charged that startup against the role's own
    // deadline and burned wait's 12s liveness grace before the first poll.
    const launchedAt = yield* Clock.currentTimeMillis
    markPending(launchedAt)
    yield* store.save(state, root)

    return ok(
      `dispatched ${params.kind} → ${role} artifact=${artifactRel}`,
      {
        task: taskRef.task,
        artifact: artifactRel,
        round,
        step: state.step,
        timeout_ms: roleTimeoutMs,
        launch,
        next: "workflow_wait",
      },
      // See the no-Herdr return above: one dispatch is outstanding, so
      // `workflow_wait` is the only call that moves this run forward.
      ["workflow_wait"],
    )
  })
