export function shellJoin(parts: string[]): string {
  return parts
    .map((p) => {
      if (p === "&&" || p === "|" || p === "exec" || p === "env") return p
      if (/^[A-Za-z0-9_./:=,@+-]+$/.test(p)) return p
      return `'${p.replace(/'/g, `'\\''`)}'`
    })
    .join(" ")
}

/** True when every foreground process name looks like a bare shell prompt. */
export function looksLikeShellOnly(names: string[]): boolean {
  if (names.length === 0) return false
  return names.every((n) => {
    const t = n.trim()
    return (
      /^(zsh|bash|sh|fish)$/i.test(t) ||
      t === "-zsh" ||
      t === "-bash" ||
      t === "-sh"
    )
  })
}
