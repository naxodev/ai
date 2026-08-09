/** Host-specific behavior used while launching interactive role harnesses. */
export type ApneaHostAdapter = {
  readonly materializeRoleAgentDir?: () => string
  readonly prepareInteractiveCommand?: (command: string[]) => string[]
  readonly beforeInteractivePrompt?: (command: string[]) => string | null
}

export const neutralHostAdapter: ApneaHostAdapter = {}
