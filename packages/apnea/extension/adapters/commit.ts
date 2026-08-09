import type { ToolResult } from "../result.ts"
import { runToolResult } from "../run-tool.ts"
import { makeAppLive } from "../services/app-live.ts"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import { commitWorkflow, type CommitParams } from "../workflows/commit.ts"

export async function workflowCommitPhase(
  params: CommitParams,
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
): Promise<ToolResult> {
  return runToolResult(
    commitWorkflow(params, process.cwd()),
    makeAppLive(hostAdapter),
  )
}
