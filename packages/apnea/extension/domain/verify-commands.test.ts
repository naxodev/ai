import { describe, expect, test } from "bun:test"
import {
  extractVerifyBlocks,
  formatVerifyBlock,
  formatVerifyCommand,
} from "./verify-commands.ts"

describe("extractVerifyBlocks", () => {
  test("preserves a fenced script exactly", () => {
    const source = `verify_file() {
  local expected="hello world"
  cat <<EOF > result.txt
$expected
EOF
}
trap 'rm -f scratch.txt' EXIT
# Keep this comment and continuation.
printf '%s' "one" \\
  > scratch.txt
verify_file
`
    const pkg = `## Verify commands

\`\`\`bash
${source}\`\`\`
`

    expect(extractVerifyBlocks(pkg)).toEqual([{ interpreter: "bash", source }])
  })

  test("keeps every Verify section fence in order and maps shell to bash", () => {
    const pkg = `# Phase

\`\`\`bash
echo sketch
\`\`\`

## Verify commands

\`\`\`sh
echo first
\`\`\`

Some explanation between checks.

\`\`\`shell
echo second
\`\`\`

\`\`\`bash
echo third
\`\`\`

## Do not touch
\`\`\`sh
echo later
\`\`\`
`

    expect(extractVerifyBlocks(pkg)).toEqual([
      { interpreter: "sh", source: "echo first\n" },
      { interpreter: "bash", source: "echo second\n" },
      { interpreter: "bash", source: "echo third\n" },
    ])
  })

  test("rejects blank and comment-only fences but preserves comments in scripts", () => {
    const pkg = `## Verify commands

\`\`\`bash

\`\`\`

\`\`\`sh
# a note, not a check
  # another note
\`\`\`

\`\`\`bash
# this comment remains
test -f README.md
\`\`\`
`

    expect(extractVerifyBlocks(pkg)).toEqual([
      {
        interpreter: "bash",
        source: "# this comment remains\ntest -f README.md\n",
      },
    ])
  })

  test("never applies legacy fallback when the Verify section has any fence", () => {
    const packages = [
      `## Verify commands
\`\`\`typescript
bun test
\`\`\``,
      `## Verify commands
\`\`\`sh

\`\`\`
bun test`,
      `## Verify commands
\`\`\`bash
# no executable check
\`\`\`
test -f README.md`,
    ]

    for (const pkg of packages) {
      expect(extractVerifyBlocks(pkg)).toEqual([])
    }
  })

  test("ignores a fake Verify heading inside an earlier non-shell fence", () => {
    const pkg = `\`\`\`markdown
## Verify commands
\`\`\`

\`\`\`bash
echo sketch
\`\`\`

## Verify commands

\`\`\`sh
echo actual
\`\`\`
`

    expect(extractVerifyBlocks(pkg)).toEqual([
      { interpreter: "sh", source: "echo actual\n" },
    ])
  })

  test("normalizes CRLF fence source to exact LF", () => {
    const pkg = [
      "## Verify commands",
      "",
      "```bash",
      "verify() {",
      "  local value=ok",
      "  cat <<EOF",
      "$value",
      "EOF",
      "}",
      "verify",
      "```",
      "",
    ].join("\r\n")

    expect(extractVerifyBlocks(pkg)).toEqual([
      {
        interpreter: "bash",
        source:
          "verify() {\n  local value=ok\n  cat <<EOF\n$value\nEOF\n}\nverify\n",
      },
    ])
  })

  test("removes opening-fence indentation while preserving deeper script indentation", () => {
    const pkg = `## Verify commands

  \`\`\`bash
  write_result() {
    cat <<EOF > indented-result.txt
  expected
  EOF
  }
  write_result
  \`\`\`
`

    expect(extractVerifyBlocks(pkg)).toEqual([
      {
        interpreter: "bash",
        source:
          "write_result() {\n  cat <<EOF > indented-result.txt\nexpected\nEOF\n}\nwrite_result\n",
      },
    ])
  })

  test("keeps nested headings and stops at an equal-rank ATX heading", () => {
    const pkg = `## Verify commands

\`\`\`sh
echo first
\`\`\`

### Platform checks

\`\`\`bash
echo nested
\`\`\`

## Implementation

\`\`\`sh
echo excluded
\`\`\`
`

    expect(extractVerifyBlocks(pkg)).toEqual([
      { interpreter: "sh", source: "echo first\n" },
      { interpreter: "bash", source: "echo nested\n" },
    ])
  })

  test("ends an ATX Verify section at the next standalone bold heading", () => {
    const pkg = `## Verify commands

\`\`\`sh
echo selected
\`\`\`

### Nested checks

\`\`\`bash
echo nested
\`\`\`

**Notes**

\`\`\`sh
echo excluded
\`\`\`
`

    expect(extractVerifyBlocks(pkg)).toEqual([
      { interpreter: "sh", source: "echo selected\n" },
      { interpreter: "bash", source: "echo nested\n" },
    ])
  })

  test("ends a bold Verify section at the next bold or ATX heading", () => {
    for (const nextHeading of ["**Notes**", "### Notes"]) {
      const pkg = `**Verify commands**

\`\`\`sh
echo selected
\`\`\`

${nextHeading}

\`\`\`bash
echo excluded
\`\`\`
`

      expect(extractVerifyBlocks(pkg)).toEqual([
        { interpreter: "sh", source: "echo selected\n" },
      ])
    }
  })

  test("recognizes fences only when their markers occupy Markdown fence lines", () => {
    const pkg = `## Verify commands

Text \`\`\`bash echo inline-danger \`\`\` is prose.

\`\`\`bash
printf '%s\\n' '\`\`\` is source'
echo selected
\`\`\`
`

    expect(extractVerifyBlocks(pkg)).toEqual([
      {
        interpreter: "bash",
        source: "printf '%s\\n' '``` is source'\necho selected\n",
      },
    ])
  })

  test("uses only the last shell fence without a Verify heading", () => {
    const pkg = `\`\`\`sh
echo first
\`\`\`

\`\`\`bash
echo last
\`\`\`
`

    expect(extractVerifyBlocks(pkg)).toEqual([
      { interpreter: "bash", source: "echo last\n" },
    ])
  })

  test("does not fall back past a comment-only last fence", () => {
    const pkg = `\`\`\`bash
echo earlier
\`\`\`

\`\`\`sh
# no check supplied
\`\`\`
`

    expect(extractVerifyBlocks(pkg)).toEqual([])
  })

  test("does not extract legacy commands from non-shell fences without a Verify heading", () => {
    for (const language of ["typescript", "javascript"]) {
      const pkg = `# Example

\`\`\`${language}
const command = "${language === "typescript" ? "bun test" : "npm test"}"
\`\`\`
`

      expect(extractVerifyBlocks(pkg)).toEqual([])
    }
  })

  test("fails closed for an unterminated Markdown fence", () => {
    const pkg = `## Verify commands

\`\`\`sh
echo valid-subset
\`\`\`

\`\`\`bash
bun test
`

    expect(extractVerifyBlocks(pkg)).toEqual([])
  })

  test("does not fall back to an earlier sketch when Verify commands exists", () => {
    const pkg = `\`\`\`bash
echo sketch
\`\`\`

## Verify commands

No commands were supplied.
`

    expect(extractVerifyBlocks(pkg)).toEqual([])
  })

  test("wraps each legacy no-fence command in a separate Bash block", () => {
    const backslash = String.fromCharCode(92)
    const pkg = `Prose with a hard break ${backslash}
$ bun test extension ${backslash}
 --coverage
$ bunx tsc --noEmit`

    expect(extractVerifyBlocks(pkg)).toEqual([
      { interpreter: "bash", source: "bun test extension  --coverage" },
      { interpreter: "bash", source: "bunx tsc --noEmit" },
    ])
  })
})

describe("formatVerifyBlock", () => {
  test("distinguishes every source line from the interpreter label", () => {
    expect(
      formatVerifyBlock({
        interpreter: "bash",
        source: "printf '%s\\n' value\n$ prompt\necho done\n",
      }),
    ).toBe(
      "bash -e [verification block]\n| printf '%s\\n' value\n| $ prompt\n| echo done",
    )
  })
})

describe("formatVerifyCommand", () => {
  test("quotes embedded single quotes and multiline source as one runnable command", () => {
    expect(
      formatVerifyCommand({
        interpreter: "sh",
        source: "printf '%s\\n' \"first\"\nprintf '%s\\n' \"second\"\n",
      }),
    ).toBe(
      `sh -e -c 'printf '"'"'%s\\n'"'"' "first"\nprintf '"'"'%s\\n'"'"' "second"\n'`,
    )
  })
})
