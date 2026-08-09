import type { ToolResult } from "../result.ts"
import { runToolResult } from "../run-tool.ts"
import { makeAppLive } from "../services/app-live.ts"
import { resolveExecutable } from "../services/herdr.ts"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import {
  setupWorkflow,
  type SetupDeps,
  type SetupParams,
} from "../workflows/setup.ts"

/**
 * Walk PATH directly rather than spawning `which` once per binary — `which`
 * itself is absent from minimal environments, which would report every
 * harness as missing.
 */
function onPath(bin: string): boolean {
  return resolveExecutable(bin) !== null
}

export async function apneaSetup(
  params: SetupParams,
  hostAdapter: ApneaHostAdapter = neutralHostAdapter,
): Promise<ToolResult> {
  const prodDeps: SetupDeps = {
    onPath,
    materializeRoleAgentDir: () =>
      hostAdapter.materializeRoleAgentDir?.() ?? null,
  }
  return runToolResult(
    setupWorkflow(params, process.cwd(), prodDeps),
    makeAppLive(hostAdapter),
  )
}
