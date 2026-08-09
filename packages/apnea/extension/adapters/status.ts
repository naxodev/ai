import { makeAppLive } from "../services/app-live.ts"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import type { ToolResult } from "../result.ts"
import { runToolResult } from "../run-tool.ts"
import { resetRoundsWorkflow } from "../workflows/reset.ts"
import { statusWorkflow } from "../workflows/status.ts"

export async function workflowStatus(
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
): Promise<ToolResult> {
  return runToolResult(statusWorkflow(process.cwd()), makeAppLive(hostAdapter))
}

export async function workflowResetRounds(
  params: {
    gate: string
  },
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
): Promise<ToolResult> {
  return runToolResult(
    resetRoundsWorkflow(params, process.cwd()),
    makeAppLive(hostAdapter),
  )
}
