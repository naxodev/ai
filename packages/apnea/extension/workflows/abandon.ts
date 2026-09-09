import { createHash, randomUUID } from "node:crypto"
import { Effect, Result } from "effect"
import { statePath } from "../domain/paths.ts"
import { GateRefused, NoRunState } from "../errors.ts"
import { ok } from "../result.ts"
import { FileSystem } from "../services/file-system.ts"
import { RunStore } from "../services/run-store.ts"
import { Herdr } from "../services/herdr.ts"

export type AbandonParams = {
  confirm?: string
  stopped_work?: boolean
  acknowledge_corrupt?: boolean
  stop_panes?: boolean
}

/** The token binds human acknowledgment to the exact persisted state preview. */
export const abandonWorkflow = Effect.fn("abandonWorkflow")(function* (
  params: AbandonParams,
  root: string,
) {
  const fs = yield* FileSystem
  const store = yield* RunStore
  const source = statePath(root)
  if (!(yield* fs.projectPathExists(root, source)))
    return yield* new NoRunState({})
  const fingerprint = yield* fs.fingerprintProjectFile(root, source)
  const token = createHash("sha256")
    .update(root)
    .update("\0")
    .update(fingerprint)
    .digest("hex")
  const loaded = yield* Effect.result(store.require(root))
  if (Result.isFailure(loaded) && loaded.failure._tag !== "StateCorrupt")
    return yield* loaded.failure
  const state = Result.isSuccess(loaded) ? loaded.success : null
  const preview = {
    confirmation: token,
    run_id: state?.run_id ?? null,
    corrupt: state === null,
    pending_role: state?.pending_role ?? null,
    pending_pane_id: state?.pending_pane_id ?? null,
    pending_artifact: state?.pending_artifact ?? null,
    pending_delivery: state?.pending_delivery ?? null,
    pending_commit: state?.pending_commit ?? null,
    last_error: state?.last_error ?? null,
    acquired_panes:
      state?.acquired_panes ?? Object.values(state?.role_panes ?? {}),
    termination:
      "unproven: done, idle, and missing panes do not establish worker exit",
    evidence: state?.run_id
      ? `.apnea/runs/${state.run_id}/`
      : ".apnea/ legacy evidence retained in place",
  }
  if (!params.confirm)
    return ok(
      `Abandon preview: ${JSON.stringify(preview, null, 2)}\nStop all work for this run, including replaced panes, manual workers, and descendants. Then use abandon --confirm=${token} --stopped-work${state ? "" : " --acknowledge-corrupt"}. Corrupt acknowledgment accepts unknown ownership and commit recovery risks.`,
      preview,
    )
  const refuse = (message: string) =>
    new GateRefused({ gate: "abandon", message, details: preview })
  if (params.confirm !== token)
    return yield* refuse(
      "State changed since preview. Preview again before confirming.",
    )
  if (state?.pending_commit)
    return yield* refuse(
      "Unresolved durable commit: run commit to recover it before abandoning. Recovery state retained.",
    )
  if (!state && !params.acknowledge_corrupt)
    return yield* refuse(
      "Corrupt state: explicitly acknowledge unknown work and commit risks with --acknowledge-corrupt.",
    )
  if (params.stop_panes) {
    const herdr = yield* Herdr
    const panes = [
      ...preview.acquired_panes,
      ...(state?.pending_pane_id
        ? [
            {
              pane_id: state.pending_pane_id,
              label: state.pending_pane_label ?? "unknown",
            },
          ]
        : []),
    ]
    const ids = [...new Set(panes.map((pane) => pane.pane_id))]
    const audit = `${source}.stop-attempt.${randomUUID()}.json`
    // Record intent before any close. Interrupted attempts remain auditable.
    yield* fs.writeProjectFile(
      root,
      audit,
      JSON.stringify(
        {
          ...preview,
          requested_panes: ids,
          outcome: "unknown until results recorded",
        },
        null,
        2,
      ),
    )
    const results = yield* Effect.forEach(ids, (id) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(herdr.requestPaneClose(id))
        return {
          pane_id: id,
          result: Result.isSuccess(result)
            ? "close requested; descendant exit unproven"
            : result.failure.message,
        }
      }),
    )
    yield* fs.writeProjectFile(
      root,
      `${audit}.results.json`,
      JSON.stringify(results, null, 2),
    )
    return yield* new GateRefused({
      gate: "abandon",
      message:
        "Close attempts recorded. Termination remains unproven; verify all workers and descendants stopped, then confirm with --stopped-work without --stop-panes.",
      details: { ...preview, audit, results },
    })
  }
  if (!params.stopped_work)
    return yield* refuse(
      "Worker termination is unproven. Stop all run work and explicitly attest with --stopped-work. State retained.",
    )
  const backup = yield* store.abandon(root, {
    ...preview,
    stopped_work: "human attested all run workers and descendants stopped",
    acknowledge_corrupt: params.acknowledge_corrupt === true,
  })
  return ok(
    `Abandoned run; exact state retained at ${backup}. Task and artifact evidence remains at its original paths.`,
    { backup, audit: `${backup}.audit.json`, ...preview },
  )
})
