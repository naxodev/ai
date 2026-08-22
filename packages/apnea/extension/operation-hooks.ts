export type OperationHooks = {
  readonly signal?: AbortSignal
  readonly onUpdate?: (partial: {
    content: Array<{ type: "text"; text: string }>
  }) => void
}
