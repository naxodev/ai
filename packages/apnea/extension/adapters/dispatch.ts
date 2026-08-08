import type { ToolResult } from "../result.ts"
import { runToolResult } from "../run-tool.ts"
import { makeAppLive } from "../services/app-live.ts"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import { dispatchWorkflow, type DispatchParams } from "../workflows/dispatch.ts"

export async function workflowDispatch(
  params: DispatchParams,
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
): Promise<ToolResult> {
  return runToolResult(
    dispatchWorkflow(params, process.cwd()),
    makeAppLive(hostAdapter),
  )
}
