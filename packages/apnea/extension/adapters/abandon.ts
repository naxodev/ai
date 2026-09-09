import { makeAppLive } from "../services/app-live.ts"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import { runToolResult } from "../run-tool.ts"
import { withRepositoryLock } from "../services/operation-lock.ts"
import { abandonWorkflow, type AbandonParams } from "../workflows/abandon.ts"
import type { OperationHooks } from "../operation-hooks.ts"

export function workflowAbandon(
  params: AbandonParams,
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
  hooks: OperationHooks = {},
) {
  return runToolResult(
    withRepositoryLock(process.cwd(), abandonWorkflow(params, process.cwd())),
    makeAppLive(hostAdapter),
    { signal: hooks.signal, operation: "abandon" },
  )
}
