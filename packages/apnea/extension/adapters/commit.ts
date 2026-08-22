import type { ToolResult } from "../result.ts"
import { runToolResult } from "../run-tool.ts"
import { makeAppLive } from "../services/app-live.ts"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import { commitWorkflow, type CommitParams } from "../workflows/commit.ts"
import { withRepositoryLock } from "../services/operation-lock.ts"
import type { OperationHooks } from "../operation-hooks.ts"

export async function workflowCommitPhase(
  params: CommitParams,
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
  hooks: OperationHooks = {},
): Promise<ToolResult> {
  return runToolResult(
    withRepositoryLock(process.cwd(), commitWorkflow(params, process.cwd())),
    makeAppLive(hostAdapter),
    { signal: hooks.signal, operation: "workflow_commit_phase" },
  )
}
