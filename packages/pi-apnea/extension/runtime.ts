import {
  createExecutor,
  createOperations,
  type ApneaHostAdapter,
} from "@naxodev/apnea"
import {
  isPiCmd,
  materializePiRoleAgentDir,
  wrapInteractiveCmdNoVim,
} from "./pi-role-agent.ts"

export const piHostAdapter: ApneaHostAdapter = {
  materializeRoleAgentDir: materializePiRoleAgentDir,
  prepareInteractiveCommand: wrapInteractiveCmdNoVim,
  beforeInteractivePrompt: (command) =>
    isPiCmd(command) ? "/vimmode off" : null,
}

export const PI_OPERATIONS = createOperations(piHostAdapter)
export const executePiOperation = createExecutor(piHostAdapter)
