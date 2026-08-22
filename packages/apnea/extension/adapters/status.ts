import { makeAppLive } from "../services/app-live.ts"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import type { ToolResult } from "../result.ts"
import { runToolResult } from "../run-tool.ts"
import { resetRoundsWorkflow } from "../workflows/reset.ts"
import { statusWorkflow } from "../workflows/status.ts"
import { withRepositoryLock } from "../services/operation-lock.ts"
import type { OperationHooks } from "../operation-hooks.ts"

export async function workflowStatus(
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
  hooks: OperationHooks = {},
): Promise<ToolResult> {
  return runToolResult(
    statusWorkflow(process.cwd()),
    makeAppLive(hostAdapter),
    {
      signal: hooks.signal,
      operation: "workflow_status",
    },
  )
}

export async function workflowResetRounds(
  params: {
    gate: string
  },
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
  hooks: OperationHooks = {},
): Promise<ToolResult> {
  return runToolResult(
    withRepositoryLock(
      process.cwd(),
      resetRoundsWorkflow(params, process.cwd()),
    ),
    makeAppLive(hostAdapter),
    { signal: hooks.signal, operation: "workflow_reset_rounds" },
  )
}
