import { describe, expect, test } from "bun:test"
import {
  expectParity,
  nvimByteCursorToOffset,
  runImplementation,
  runNeovim,
  type ParityCase,
} from "./parity-harness.ts"

describe("Neovim parity", () => {
  test("motions preserve Vim cursor semantics across lines, words, counts, and UTF-8 bytes", () => {
    expectParity([
      {
        name: "counted character motion",
        text: "abcd",
        cursor: 0,
        keys: ["3", "l"],
      },
      {
        name: "word forward",
        text: "one, two three",
        cursor: 0,
        keys: ["2", "w"],
      },
      {
        name: "word backward",
        text: "one two three",
        cursor: 8,
        keys: ["2", "b"],
      },
      {
        name: "word end advances from an endpoint",
        text: "one two",
        cursor: 2,
        keys: ["e"],
      },
      {
        name: "counted word end crosses adjacent classes once",
        text: "a,b c",
        cursor: 0,
        keys: ["2", "e"],
      },
      {
        name: "first nonblank",
        text: "one\n  two",
        cursor: 0,
        keys: ["j", "^"],
      },
      {
        name: "counted line end",
        text: "one\ntwo\nthree",
        cursor: 0,
        keys: ["2", "$"],
      },
      {
        name: "multibyte horizontal",
        text: "a😀éb",
        cursor: 0,
        keys: ["2", "l"],
      },
      {
        name: "tab-aware vertical motion",
        text: "\tx\nabcdefghij",
        cursor: 1,
        keys: ["j"],
      },
    ])
  })

  test("operators match Vim text, cursor, mode, and unnamed register type", () => {
    expectParity([
      {
        name: "delete word",
        text: "one two three",
        cursor: 0,
        keys: ["d", "w"],
      },
      {
        name: "multiplied delete",
        text: "one two three four five six seven",
        cursor: 0,
        keys: ["2", "d", "3", "w"],
      },
      {
        name: "delete lines",
        text: "one\ntwo\nthree\nfour",
        cursor: 4,
        keys: ["2", "d", "d"],
      },
      {
        name: "change word enters insert",
        text: "one two",
        cursor: 0,
        keys: ["c", "w"],
      },
      {
        name: "change Unicode punctuation",
        text: "😀 x",
        cursor: 0,
        keys: ["c", "w"],
      },
      {
        name: "counted change word crosses adjacent classes once",
        text: "a,b c",
        cursor: 0,
        keys: ["2", "c", "w"],
      },
      {
        name: "yank upward is linewise",
        text: "  one\n  two\n  three",
        cursor: 15,
        keys: ["y", "k"],
      },
      {
        name: "delete to buffer start",
        text: "one\ntwo\nthree",
        cursor: 9,
        keys: ["d", "g", "g"],
      },
      { name: "delete to line end", text: "one two", cursor: 4, keys: ["D"] },
      {
        name: "counted character delete",
        text: "abcdef",
        cursor: 1,
        keys: ["3", "x"],
      },
      {
        name: "backward character delete",
        text: "abcdef",
        cursor: 3,
        keys: ["2", "X"],
      },
    ])
  })

  test("paste, replace, joins, and visual operators retain Vim register behavior", () => {
    expectParity([
      {
        name: "character paste after",
        text: "ac",
        cursor: 0,
        keys: ["2", "p"],
        register: { text: "b", type: "characterwise" },
      },
      {
        name: "line paste before",
        text: "one\nthree",
        cursor: 4,
        keys: ["P"],
        register: { text: "two", type: "linewise" },
      },
      {
        name: "counted replace",
        text: "abcdef",
        cursor: 1,
        keys: ["3", "r", "z"],
      },
      {
        name: "replace with line break",
        text: "abc",
        cursor: 1,
        keys: ["r", "return"],
      },
      {
        name: "counted replace with one line break",
        text: "abcd",
        cursor: 1,
        keys: ["2", "r", "return"],
      },
      {
        name: "join three lines",
        text: "one\n  two\nthree",
        cursor: 0,
        keys: ["3", "J"],
      },
      {
        name: "visual character delete",
        text: "abcdef",
        cursor: 1,
        keys: ["v", "2", "l", "d"],
      },
      {
        name: "visual line yank",
        text: "one\ntwo\nthree",
        cursor: 4,
        keys: ["V", "j", "y"],
      },
    ])
  })

  test("insert entry and one-shot normal mode match Vim where mode is observable", () => {
    expectParity([
      { name: "append", text: "abc", cursor: 1, keys: ["a"] },
      { name: "append at line end", text: "abc\ndef", cursor: 0, keys: ["A"] },
      {
        name: "insert at first nonblank",
        text: "  abc",
        cursor: 4,
        keys: ["I"],
      },
      { name: "open below", text: "abc\ndef", cursor: 1, keys: ["o"] },
      { name: "open above", text: "abc\ndef", cursor: 5, keys: ["O"] },
      {
        name: "escape leaves insert",
        text: "a😀b",
        cursor: 3,
        mode: "insert",
        keys: ["escape"],
      },
      {
        name: "escape leaves insert at end of line",
        text: "abc",
        cursor: 3,
        mode: "insert",
        keys: ["escape"],
      },
      {
        name: "one-shot motion",
        text: "one two",
        cursor: 0,
        mode: "insert",
        keys: ["ctrl+o", "w"],
      },
    ])
  })

  test("byte columns become JS UTF-16 offsets only at complete grapheme boundaries", () => {
    const text = "a😀éz\nnext"
    expect(nvimByteCursorToOffset(text, 1, 1)).toBe(1)
    expect(nvimByteCursorToOffset(text, 1, 2)).toBe(1)
    expect(nvimByteCursorToOffset(text, 1, 5)).toBe(3)
    expect(nvimByteCursorToOffset(text, 1, 6)).toBe(3)
    expect(nvimByteCursorToOffset(text, 2, 0)).toBe(7)
  })
})

describe("intentional Vim divergences", () => {
  test("buffer jumps always use first nonblank instead of preserving the desired column", () => {
    const testCase: ParityCase = {
      name: "buffer start with a different desired column",
      text: "  one\n two",
      cursor: 7,
      keys: ["g", "g"],
    }
    const implementation = runImplementation(testCase)
    const neovim = runNeovim([testCase])[0]

    expect(implementation).toEqual({
      text: "  one\n two",
      cursor: 2,
      mode: "normal",
      register: { text: "", type: "characterwise" },
    })
    expect(neovim).toEqual({
      text: "  one\n two",
      cursor: 1,
      mode: "normal",
      register: { text: "", type: "characterwise" },
    })
  })
})
