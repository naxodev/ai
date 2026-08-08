export {
  createOperations,
  createExecutor,
  executeOperation,
  findByTool,
  findByVerb,
  OPERATIONS,
  toolToVerb,
  type Operation,
  type ExecuteOperation,
} from "./registry.ts"
export { parseFlags, parseNumFlag } from "./cli/parse.ts"
export { DISPATCH_KINDS, type DispatchKind } from "./domain/state-machine.ts"
export { packageRoot } from "./domain/paths.ts"
export { formatResult, toolContent, type ToolResult } from "./result.ts"
export type { ApneaHostAdapter } from "./host-adapter.ts"
