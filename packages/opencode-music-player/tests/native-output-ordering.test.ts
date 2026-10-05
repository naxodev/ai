import { expect, test } from "bun:test"
import { PNG } from "pngjs"
import { kittyDisplayPng } from "../kitty-graphics.ts"

const transferCount = 24

function syntheticArtwork(): string {
  const png = new PNG({ width: 300, height: 169 })
  let seed = 123
  for (let index = 0; index < png.data.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    png.data[index] = index % 4 === 3 ? 255 : seed >>> 24
  }
  return PNG.sync.write(png).toString("base64")
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

const nativeThreadTest = process.platform === "darwin" ? test : test.skip

nativeThreadTest(
  "serializes each native artwork transfer with OpenTUI's native output thread",
  async () => {
    const chunks: Buffer[] = []
    const child = Bun.spawn(
      [process.execPath, `${import.meta.dir}/native-output-ordering-child.ts`],
      {
        env: {
          ...process.env,
          HERDR_ENV: "",
          MUSIC_ARTWORK_OUTPUT_COUNT: String(transferCount),
          TERM: "xterm-256color",
          TMUX: "",
        },
        stderr: "pipe",
        terminal: {
          cols: 140,
          rows: 70,
          data(_terminal, bytes) {
            chunks.push(Buffer.from(bytes))
          },
        },
      },
    )
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill(9)
    }, 30_000)

    try {
      const exitCode = await child.exited
      const stderr = await new Response(child.stderr).text()
      expect(timedOut, "native output probe timed out").toBeFalse()
      expect(exitCode, stderr).toBe(0)
    } finally {
      clearTimeout(timer)
      child.terminal?.close()
    }

    const expected = kittyDisplayPng(
      syntheticArtwork(),
      42,
      110,
      24,
      24,
      0,
    ).join("")
    // An intact transfer must stay contiguous. A cursor/frame byte inside it
    // changes Kitty's final-chunk cursor and can place art over the input.
    expect(occurrences(Buffer.concat(chunks).toString(), expected)).toBe(
      transferCount,
    )
  },
  35_000,
)
