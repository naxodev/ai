import { describe, expect, test } from "bun:test"
import {
  kittyDelete,
  kittyDeletePlacement,
  kittyDisplayPng,
  kittyPlace,
  kittyTransmitPng,
  tmuxPassthrough,
  writeGraphics,
} from "../kitty-graphics.ts"

function withEnv(
  patch: { TMUX?: string | undefined; HERDR_ENV?: string | undefined },
  run: () => void,
) {
  const previous = {
    TMUX: process.env.TMUX,
    HERDR_ENV: process.env.HERDR_ENV,
  }
  try {
    if (patch.TMUX === undefined) delete process.env.TMUX
    else process.env.TMUX = patch.TMUX
    if (patch.HERDR_ENV === undefined) delete process.env.HERDR_ENV
    else process.env.HERDR_ENV = patch.HERDR_ENV
    run()
  } finally {
    if (previous.TMUX === undefined) delete process.env.TMUX
    else process.env.TMUX = previous.TMUX
    if (previous.HERDR_ENV === undefined) delete process.env.HERDR_ENV
    else process.env.HERDR_ENV = previous.HERDR_ENV
  }
}

function fakeRenderer() {
  const writes: string[] = []
  const renderer = {
    stdout: {},
    realStdoutWrite(data: string) {
      writes.push(data)
    },
  }
  return { writes, renderer }
}

describe("Kitty graphics commands", () => {
  test("chunks artwork without exceeding the protocol payload limit", () => {
    const commands = kittyTransmitPng("A".repeat(9_000), 42)

    expect(commands).toHaveLength(3)
    expect(commands[0]).toStartWith("\x1b_Ga=t,f=100,i=42,q=2,m=1;")
    expect(commands[1]).toStartWith("\x1b_Gm=1;")
    expect(commands[2]).toStartWith("\x1b_Gm=0;")
    for (const command of commands) {
      expect(
        command.slice(command.indexOf(";") + 1, -2).length,
      ).toBeLessThanOrEqual(4096)
    }
  })

  test("places artwork at one-based terminal coordinates", () => {
    expect(kittyPlace(42, 7, 3, 5, 24, 12)).toContain(
      "\x1b[6;4H\x1b_Ga=p,i=42,p=7,q=2,c=24,r=12,z=1;",
    )
  })

  test("atomically displays the first PNG at its reserved cells", () => {
    const commands = kittyDisplayPng("AAAA", 42, 3, 5, 24, 12)

    expect(commands).toEqual([
      "\x1b7\x1b[6;4H\x1b_Ga=T,f=100,i=42,p=42,q=2,C=1,c=24,r=12,z=1,m=0;AAAA\x1b\\\x1b8",
    ])
  })

  // Resize cleanup uses placement delete (d=i); full teardown uses image delete (d=I).
  test("deletes image data during cleanup", () => {
    expect(kittyDelete(42)).toBe("\x1b_Ga=d,d=I,i=42,q=2;\x1b\\")
  })

  test("deletes only the old placement during resize", () => {
    expect(kittyDeletePlacement(42)).toBe("\x1b_Ga=d,d=i,i=42,q=2;\x1b\\")
  })

  test("uses OpenTUI's captured raw writer instead of its span feed", () => {
    withEnv({ TMUX: undefined, HERDR_ENV: undefined }, () => {
      const { writes, renderer } = fakeRenderer()
      expect(writeGraphics(renderer as never, "graphics")).toBe(true)
      expect(writes).toEqual(["graphics"])
    })
  })

  test("restores the cursor when a multi-chunk display write fails", () => {
    withEnv({ TMUX: undefined, HERDR_ENV: undefined }, () => {
      const writes: string[] = []
      let attempts = 0
      const renderer = {
        stdout: {},
        realStdoutWrite(data: string) {
          attempts++
          if (attempts === 2) throw new Error("write failed")
          writes.push(data)
        },
      }
      const commands = kittyDisplayPng("A".repeat(5_000), 42, 3, 5, 24, 12)

      expect(writeGraphics(renderer as never, commands)).toBe(false)
      expect(writes).toEqual([commands[0]!, "\x1b8"])
    })
  })

  test("wraps graphics for tmux without Herdr", () => {
    withEnv({ TMUX: "1", HERDR_ENV: undefined }, () => {
      const { writes, renderer } = fakeRenderer()
      expect(writeGraphics(renderer as never, "graphics")).toBe(true)
      expect(writes).toEqual([tmuxPassthrough("graphics")])
    })
  })

  test("does not wrap graphics under Herdr even when TMUX is set", () => {
    withEnv({ TMUX: "1", HERDR_ENV: "1" }, () => {
      const { writes, renderer } = fakeRenderer()
      expect(writeGraphics(renderer as never, "graphics")).toBe(true)
      expect(writes).toEqual(["graphics"])
    })
  })

  test("wraps graphics for tmux and doubles nested escapes", () => {
    expect(tmuxPassthrough("\x1b_Ga=p;\x1b\\")).toBe(
      "\x1bPtmux;\x1b\x1b_Ga=p;\x1b\x1b\\\x1b\\",
    )
  })
})
