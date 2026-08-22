/**
 * @naxodev/pi-apnea — Pi adapter for the Apnea workflow.
 *
 * Definitions come from @naxodev/apnea; this file only binds them to Pi.
 * The standalone CLI binds the same registry to argv.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { toolContent } from "@naxodev/apnea"
import { registerApneaCommands } from "./commands.ts"
import { executePiOperation, PI_OPERATIONS } from "./runtime.ts"

export default function (pi: ExtensionAPI) {
  // `/apnea …` for humans (autocomplete); tools remain for the model
  registerApneaCommands(pi, PI_OPERATIONS, executePiOperation)

  for (const op of PI_OPERATIONS) {
    if (op.tool === null) continue

    // wait is the one operation with streaming + abort; Pi's exclusive.
    if (op.tool === "workflow_wait") {
      pi.registerTool({
        name: op.tool,
        label: "Apnea wait",
        description: [op.summary, op.guidance].filter(Boolean).join(" "),
        parameters: op.params,
        executionMode: "sequential",
        async execute(
          _id: string,
          params: { poll_ms?: number; budget_ms?: number },
          signal: AbortSignal | undefined,
          onUpdate:
            | ((partial: {
                content: Array<{ type: "text"; text: string }>
                details: unknown
              }) => void)
            | undefined,
        ) {
          return toolContent(
            // Pi blocks in one chunk by design: it streams progress and
            // can be interrupted, so it has no host shell timeout to fit
            // inside. The registry handler no longer injects this — only
            // the CLI reaches that, and it must stay bounded.
            await executePiOperation(
              op.verb,
              {
                ...params,
                budget_ms: params.budget_ms ?? Number.MAX_SAFE_INTEGER,
              },
              {
                signal,
                onUpdate: onUpdate
                  ? (partial) =>
                      onUpdate({
                        content: partial.content,
                        details: {
                          ok: true,
                          message: partial.content[0]?.text ?? "",
                        },
                      })
                  : undefined,
              },
            ),
          )
        },
      })
      continue
    }

    pi.registerTool({
      name: op.tool,
      label: `Apnea ${op.verb}`,
      description: [op.summary, op.guidance].filter(Boolean).join(" "),
      parameters: op.params,
      executionMode: "sequential",
      async execute(_id: string, params: Record<string, unknown>) {
        return toolContent(await executePiOperation(op.verb, params))
      },
    })
  }
}
