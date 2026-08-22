import { makeAppLive } from "../services/app-live.ts"
import type { ApneaHostAdapter } from "../host-adapter.ts"
import { neutralHostAdapter } from "../host-adapter.ts"
import type { ToolResult } from "../result.ts"
import { runToolResult } from "../run-tool.ts"
import { startWorkflow, type StartParams } from "../workflows/start.ts"
import { withRepositoryLock } from "../services/operation-lock.ts"

export async function workflowStart(
  params: StartParams,
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
): Promise<ToolResult> {
  return runToolResult(
    withRepositoryLock(process.cwd(), startWorkflow(params, process.cwd())),
    makeAppLive(hostAdapter),
  )
}
