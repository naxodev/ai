export type VerifyBlock = {
  readonly interpreter: "bash" | "sh"
  readonly source: string
}

type FenceRegion = {
  readonly start: number
  readonly bodyStart: number
  readonly bodyEnd: number
  readonly info: string
  readonly indent: number
}

type Heading = {
  readonly start: number
  readonly end: number
  readonly rank: number | null
  readonly text: string
}

export function normalizeVerifySource(source: string): string {
  return source.replace(/\r\n?/g, "\n")
}

function atxHeading(line: string): { rank: number; text: string } | null {
  const match = /^ {0,3}(#{1,6})(?:[\t ]+(.*?)|[\t ]*)$/.exec(line)
  if (!match) return null
  return {
    rank: match[1]!.length,
    text: (match[2] ?? "").replace(/[\t ]+#+[\t ]*$/, "").trim(),
  }
}

function boldHeading(line: string): string | null {
  return /^ {0,3}\*\*(.+?)\*\*[\t ]*$/.exec(line)?.[1]?.trim() ?? null
}

function scanMarkdown(text: string): {
  fences: FenceRegion[]
  headings: Heading[]
  unclosedFence: boolean
} {
  const fences: FenceRegion[] = []
  const headings: Heading[] = []
  let open:
    | {
        marker: "`" | "~"
        length: number
        start: number
        bodyStart: number
        info: string
        indent: number
      }
    | undefined

  let offset = 0
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset)
    const lineEnd = newline === -1 ? text.length : newline
    const next = newline === -1 ? text.length : newline + 1
    const line = text.slice(offset, lineEnd)

    if (open) {
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)?.[1]
      if (closing?.[0] === open.marker && closing.length >= open.length) {
        fences.push({
          start: open.start,
          bodyStart: open.bodyStart,
          bodyEnd: offset,
          info: open.info,
          indent: open.indent,
        })
        open = undefined
      }
    } else {
      const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
      const marker = opening?.[2]
      const info = opening?.[3] ?? ""
      if (marker && !(marker[0] === "`" && info.includes("`"))) {
        open = {
          marker: marker[0] as "`" | "~",
          length: marker.length,
          start: offset,
          bodyStart: next,
          info: info.trim(),
          indent: opening[1]!.length,
        }
      } else {
        const atx = atxHeading(line)
        const bold = boldHeading(line)
        if (atx) {
          headings.push({
            start: offset,
            end: next,
            rank: atx.rank,
            text: atx.text,
          })
        } else if (bold !== null) {
          headings.push({ start: offset, end: next, rank: null, text: bold })
        }
      }
    }

    offset = next
  }

  return { fences, headings, unclosedFence: open !== undefined }
}

function toVerifyBlock(text: string, fence: FenceRegion): VerifyBlock | null {
  const language = fence.info.toLowerCase()
  if (language !== "bash" && language !== "sh" && language !== "shell") {
    return null
  }

  const body = text.slice(fence.bodyStart, fence.bodyEnd)
  const source =
    fence.indent === 0
      ? body
      : body.replace(new RegExp(`^ {0,${fence.indent}}`, "gm"), "")
  const hasExecutableLine = source
    .split("\n")
    .some((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
  if (!hasExecutableLine) return null

  return {
    interpreter: language === "sh" ? "sh" : "bash",
    source,
  }
}

function isShellFence(fence: FenceRegion): boolean {
  return /^(?:bash|sh|shell)$/i.test(fence.info)
}

/** Does this line end in an odd run of backslashes? */
function endsInContinuation(line: string): boolean {
  const run = /(\\+)$/.exec(line)
  return run !== null && run[1]!.length % 2 === 1
}

function extractLegacyBlocks(text: string): VerifyBlock[] {
  const blocks: VerifyBlock[] = []
  const rawLines = text.split("\n")
  for (let i = 0; i < rawLines.length; i++) {
    const match = rawLines[i]!.match(
      /^\s*(?:\$\s+)?((?:test |node |npm |bun |bunx |chmod |head ).+)$/,
    )
    if (!match) continue
    let source = match[1]!
    while (endsInContinuation(source) && i + 1 < rawLines.length) {
      source = source.slice(0, -1) + rawLines[++i]!
    }
    if (endsInContinuation(source)) source = source.slice(0, -1)
    blocks.push({ interpreter: "bash", source: source.trim() })
  }
  return blocks
}

/**
 * Extract interpreter-aware verification scripts from a phase package.
 * A Verify commands section owns every shell fence below it. Without that
 * section, only the last shell fence is verification, matching legacy package
 * selection without splitting a script into unrelated command lines.
 */
export function extractVerifyBlocks(phasePackageText: string): VerifyBlock[] {
  const text = normalizeVerifySource(phasePackageText)
  const { fences, headings, unclosedFence } = scanMarkdown(text)
  if (unclosedFence) return []
  const verifyHeading = headings.find(
    (heading) => heading.text.toLowerCase() === "verify commands",
  )

  if (verifyHeading) {
    const nextHeading = headings.find(
      (heading) =>
        heading.start >= verifyHeading.end &&
        (heading.rank === null ||
          verifyHeading.rank === null ||
          (heading.rank !== null && heading.rank <= verifyHeading.rank)),
    )
    const sectionEnd = nextHeading?.start ?? text.length
    const sectionFences = fences.filter(
      (fence) => fence.start >= verifyHeading.end && fence.start < sectionEnd,
    )
    const blocks = sectionFences
      .filter(isShellFence)
      .map((fence) => toVerifyBlock(text, fence))
      .filter((block): block is VerifyBlock => block !== null)
    return sectionFences.length > 0
      ? blocks
      : extractLegacyBlocks(text.slice(verifyHeading.end, sectionEnd))
  }

  const shellFences = fences.filter(isShellFence)
  if (shellFences.length > 0) {
    const block = toVerifyBlock(text, shellFences[shellFences.length - 1]!)
    return block ? [block] : []
  }

  return fences.length === 0 ? extractLegacyBlocks(text) : []
}

/** Render a block for readable logs without leaking its temp path. */
export function formatVerifyBlock(block: VerifyBlock): string {
  const source = normalizeVerifySource(block.source)
  const body = source.endsWith("\n") ? source.slice(0, -1) : source
  const displayedSource = body
    .split("\n")
    .map((line) => `| ${line}`)
    .join("\n")
  return `${block.interpreter} -e [verification block]\n${displayedSource}`
}

/** Render a verification block as a runnable command without its temp path. */
export function formatVerifyCommand(block: VerifyBlock): string {
  const source = normalizeVerifySource(block.source)
  const quotedSource = `'${source.replaceAll("'", `'"'"'`)}'`
  return `${block.interpreter} -e -c ${quotedSource}`
}
