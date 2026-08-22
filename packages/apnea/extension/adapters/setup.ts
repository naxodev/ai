import type { ToolResult } from "../result.ts"
import * as os from "node:os"
import { runToolResult } from "../run-tool.ts"
import { makeAppLive } from "../services/app-live.ts"
import { resolveExecutable } from "../services/herdr.ts"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import {
  setupWorkflow,
  type SetupDeps,
  type SetupParams,
} from "../workflows/setup.ts"
import { withSetupLocks } from "../services/operation-lock.ts"

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
  const trustedHome = os.homedir()
  const prodDeps: SetupDeps = {
    onPath,
    trustedHome: () => trustedHome,
    materializeRoleAgentDir: () =>
      hostAdapter.materializeRoleAgentDir?.() ?? null,
  }
  const root = process.cwd()
  const workflow = setupWorkflow(params, root, prodDeps)
  return runToolResult(
    withSetupLocks(
      trustedHome,
      root,
      params.project === true || params.agents_md === true,
      workflow,
    ),
    makeAppLive(hostAdapter),
  )
}
