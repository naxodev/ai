export type VimKeyBinding = readonly [bind: string, key: string]

export const vimKeyBindings: readonly VimKeyBinding[] = [
  ..."abcdefghijklmnopqrstuvwxyz".split("").map((key) => [key, key] as const),
  ..."abcdefghijklmnopqrstuvwxyz"
    .split("")
    .map((key) => [`shift+${key}`, key.toUpperCase()] as const),
  ..."0123456789".split("").map((key) => [key, key] as const),
  ["shift+4", "$"],
  ["shift+6", "^"],
  ["shift+1", "!"],
  ["shift+2", "@"],
  ["shift+3", "#"],
  ["shift+5", "%"],
  ["shift+7", "&"],
  ["shift+8", "*"],
  ["shift+9", "("],
  ["shift+0", ")"],
  ["shift+semicolon", ":"],
  ["return", "return"],
  ["escape", "escape"],
  ["ctrl+[", "ctrl+["],
  ["backspace", "backspace"],
  ["ctrl+r", "ctrl+r"],
  ["space", "space"],
  ["tab", "tab"],
  ["minus", "-"],
  ["equal", "="],
  ["leftbracket", "["],
  ["rightbracket", "]"],
  ["backslash", "\\"],
  ["semicolon", ";"],
  ["quote", "'"],
  ["comma", ","],
  ["period", "."],
  ["/", "/"],
  ["backquote", "`"],
  ["shift+minus", "_"],
  ["shift+equal", "+"],
  ["shift+leftbracket", "{"],
  ["shift+rightbracket", "}"],
  ["shift+backslash", "|"],
  ["shift+quote", '"'],
  ["shift+comma", "<"],
  ["shift+period", ">"],
  ["shift+slash", "?"],
  ["shift+backquote", "~"],
]

const reservedBindings = new Set(["ctrl+[", "v", "shift+v"])

export function selectVimKeyBindings(
  hostPrefixKeys: ReadonlySet<string>,
  options: { respectHostPrefixes: boolean; nativeSubmit?: boolean },
) {
  return vimKeyBindings.flatMap(([bind, key], index) => {
    const selected =
      (!options.nativeSubmit || bind !== "return") &&
      (!options.respectHostPrefixes ||
        reservedBindings.has(bind) ||
        !hostPrefixKeys.has(bind.toLowerCase()))
    return selected ? [{ bind, key, index }] : []
  })
}

export function printableHostPrefix(key: string) {
  if (key === "space") return " "
  return [...key].length === 1 ? key : undefined
}
