import type { ToolResult } from "../result.ts"
import { runToolResult } from "../run-tool.ts"
import { makeAppLive } from "../services/app-live.ts"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import { dispatchWorkflow, type DispatchParams } from "../workflows/dispatch.ts"
import { withRepositoryLock } from "../services/operation-lock.ts"
import type { OperationHooks } from "../operation-hooks.ts"

export async function workflowDispatch(
  params: DispatchParams,
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
  hooks: OperationHooks = {},
): Promise<ToolResult> {
  return runToolResult(
    withRepositoryLock(process.cwd(), dispatchWorkflow(params, process.cwd())),
    makeAppLive(hostAdapter),
    {
      signal: hooks.signal,
      operation: "dispatch_role",
      abortDetails: { delivery: "unknown" },
    },
  )
}
