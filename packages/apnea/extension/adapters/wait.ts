import type { ToolResult } from "../result.ts"
import { runToolResult } from "../run-tool.ts"
import { makeAppLive } from "../services/app-live.ts"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import {
  waitWorkflow,
  type WaitHooks,
  type WaitParams,
} from "../workflows/wait.ts"

export async function workflowWait(
  params: WaitParams,
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
  hooks: WaitHooks = {},
): Promise<ToolResult> {
  return runToolResult(
    waitWorkflow(params, process.cwd(), hooks),
    makeAppLive(hostAdapter),
  )
}
