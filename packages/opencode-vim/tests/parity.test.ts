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
      {
        name: "vwed exact parity",
        text: "one two three",
        cursor: 0,
        keys: ["v", "w", "e", "d"],
      },
      {
        name: "visual zero retains original anchor",
        text: "one two",
        cursor: 1,
        keys: ["v", "$", "0", "d"],
      },
      {
        name: "visual caret retains original anchor",
        text: "  one two",
        cursor: 4,
        keys: ["v", "$", "^", "d"],
      },
      {
        name: "visual dollar retains original anchor",
        text: "one two",
        cursor: 5,
        keys: ["v", "0", "$", "d"],
      },
      {
        name: "visual G retains original anchor",
        text: "one\ntwo\nthree",
        cursor: 5,
        keys: ["v", "0", "G", "d"],
      },
      {
        name: "visual gg retains original anchor",
        text: "one\ntwo\nthree",
        cursor: 4,
        keys: ["v", "j", "g", "g", "d"],
      },
      {
        name: "visual counted percent preserves percentage",
        text: "a\nb\nc\nd\ne",
        cursor: 0,
        keys: ["v", "5", "0", "%", "d"],
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

  test("big words and line-local character finds match counts and punctuation", () => {
    expectParity([
      {
        name: "big word skips punctuation",
        text: "one,two three",
        cursor: 0,
        keys: ["W"],
      },
      {
        name: "counted big word end",
        text: "one,two three four",
        cursor: 0,
        keys: ["2", "E"],
      },
      {
        name: "big word backward",
        text: "one two,three",
        cursor: 8,
        keys: ["B"],
      },
      {
        name: "counted find",
        text: "a,x,x,x",
        cursor: 0,
        keys: ["2", "f", "x"],
      },
      { name: "reverse till", text: "x-a-x-a", cursor: 6, keys: ["T", "x"] },
      {
        name: "find repeat and reverse",
        text: "a-x-x-x",
        cursor: 0,
        keys: ["t", "x", ";", ","],
      },
      {
        name: "failed find stays put",
        text: "one\ntwo x",
        cursor: 0,
        keys: ["f", "x"],
      },
      {
        name: "find crosses Unicode by grapheme",
        text: "😀-x-x",
        cursor: 0,
        keys: ["2", "f", "x"],
      },
      {
        name: "find lands on a complete combining grapheme",
        text: "x-é-z",
        cursor: 0,
        keys: ["f", "e"],
      },
    ])
  })

  test("find and delimiter motions compose with operators", () => {
    expectParity([
      {
        name: "delete through find",
        text: "one, two",
        cursor: 0,
        keys: ["d", "f", ","],
      },
      {
        name: "delete big word excludes destination",
        text: "one,two three",
        cursor: 0,
        keys: ["d", "W"],
      },
      {
        name: "delete by repeated find",
        text: "a-x-x-x",
        cursor: 0,
        keys: ["f", "x", "d", ";"],
      },
      {
        name: "change till find",
        text: "one, two",
        cursor: 0,
        keys: ["c", "t", ","],
      },
      {
        name: "failed change find",
        text: "one\ntwo",
        cursor: 0,
        keys: ["c", "f", "x"],
      },
      {
        name: "matching nested delimiter",
        text: "😀 ({a[b]}) z",
        cursor: 3,
        keys: ["%"],
      },
      {
        name: "delete matching pair",
        text: "x ({a[b]}) y",
        cursor: 2,
        keys: ["d", "%"],
      },
    ])
  })

  test("word, paired, quote, and visual text objects match Neovim", () => {
    expectParity([
      {
        name: "inner word punctuation count",
        text: "one, two",
        cursor: 0,
        keys: ["d", "2", "i", "w"],
      },
      {
        name: "around word trailing whitespace",
        text: "one   two",
        cursor: 0,
        keys: ["d", "a", "w"],
      },
      {
        name: "inner whitespace",
        text: "one   two",
        cursor: 3,
        keys: ["d", "i", "w"],
      },
      {
        name: "around whitespace",
        text: "one   two three",
        cursor: 3,
        keys: ["d", "a", "w"],
      },
      {
        name: "inner nested paren",
        text: "x (a (b) c) y",
        cursor: 6,
        keys: ["d", "i", "("],
      },
      {
        name: "outer counted paren",
        text: "x (a (b) c) y",
        cursor: 6,
        keys: ["d", "2", "a", "("],
      },
      {
        name: "inner brace Unicode",
        text: "x {😀 value} y",
        cursor: 4,
        keys: ["y", "i", "{"],
      },
      {
        name: "around bracket",
        text: "x [a, b] y",
        cursor: 4,
        keys: ["d", "a", "["],
      },
      {
        name: "inner double quote",
        text: 'say "one two" now',
        cursor: 6,
        keys: ["c", "i", '"'],
      },
      {
        name: "around single quote",
        text: "say 'one two' now",
        cursor: 6,
        keys: ["d", "a", "'"],
      },
      {
        name: "visual inner quote delete",
        text: 'say "one two" now',
        cursor: 6,
        keys: ["v", "i", '"', "d"],
      },
      {
        name: "change empty inner pair",
        text: "()",
        cursor: 0,
        keys: ["c", "i", "("],
        register: { text: "seed", type: "characterwise" },
      },
    ])
  })

  test("reviewed operator and text-object edge cases match Neovim", () => {
    expectParity([
      {
        name: "delete W includes EOF",
        text: "one",
        cursor: 0,
        keys: ["d", "W"],
      },
      {
        name: "delete W stops before a single following line",
        text: "one\ntwo",
        cursor: 0,
        keys: ["d", "W"],
      },
      {
        name: "W stops on a blank line instead of collapsing newlines",
        text: "one\n\ntwo",
        cursor: 0,
        keys: ["W"],
      },
      {
        name: "B stops on a blank line instead of collapsing newlines",
        text: "one\n\ntwo",
        cursor: 5,
        keys: ["B"],
      },
      {
        name: "E skips blank lines to the next big-word endpoint",
        text: "one\n\ntwo",
        cursor: 2,
        keys: ["E"],
      },
      {
        name: "Unicode W stops on a blank line",
        text: "😀one\n\nétwo",
        cursor: 0,
        keys: ["W"],
      },
      {
        name: "delete 2W across complete lines is linewise",
        text: "one\ntwo\nthree",
        cursor: 0,
        keys: ["d", "2", "W"],
      },
      {
        name: "change W preserves following whitespace",
        text: "one   two",
        cursor: 0,
        keys: ["c", "W"],
      },
      {
        name: "backward big-word yank lands at range start",
        text: "one two three",
        cursor: 8,
        keys: ["y", "B"],
      },
      {
        name: "failed backward change remains normal",
        text: "one",
        cursor: 0,
        keys: ["c", "B"],
      },
      {
        name: "backward F excludes cursor",
        text: "a-x-x",
        cursor: 4,
        keys: ["d", "F", "x"],
      },
      {
        name: "backward T excludes cursor",
        text: "x-a-x",
        cursor: 4,
        keys: ["d", "T", "x"],
      },
      {
        name: "counted inner word includes adjacent whitespace run",
        text: "one   two three",
        cursor: 3,
        keys: ["d", "2", "i", "w"],
      },
      {
        name: "daw does not consume the following newline",
        text: "one\ntwo",
        cursor: 0,
        keys: ["d", "a", "w"],
      },
      {
        name: "final-line diw stays characterwise and preserves its newline",
        text: "one\ntwo",
        cursor: 4,
        keys: ["d", "i", "w"],
      },
      {
        name: "aw on an indented word without trailing space preserves indentation",
        text: "  one",
        cursor: 2,
        keys: ["d", "a", "w"],
      },
      {
        name: "daw on a blank line has newline and register parity",
        text: "one\n\ntwo",
        cursor: 4,
        keys: ["d", "a", "w"],
      },
      {
        name: "counted inner words across lines become linewise",
        text: "one\ntwo",
        cursor: 0,
        keys: ["d", "2", "i", "w"],
      },
      {
        name: "Unicode counted inner words cross lines intact",
        text: "één\ntwo",
        cursor: 0,
        keys: ["d", "2", "i", "w"],
      },
      {
        name: "unavailable counted inner word does not partially delete",
        text: "one,",
        cursor: 0,
        keys: ["d", "3", "i", "w"],
      },
      {
        name: "empty inner word is a valid change object",
        text: "",
        cursor: 0,
        keys: ["c", "i", "w"],
      },
      {
        name: "counted inner quote includes delimiters",
        text: 'xx "abc" yy',
        cursor: 4,
        keys: ["d", "2", "i", '"'],
      },
      {
        name: "inner quote between regions uses adjacent quote boundaries",
        text: '"one" "two"',
        cursor: 5,
        keys: ["d", "i", '"'],
      },
      {
        name: "counted delimiter does not select a later sibling pair",
        text: "(one) (two)",
        cursor: 1,
        keys: ["d", "2", "i", "("],
      },
      {
        name: "counted around word at EOF keeps leading whitespace",
        text: "one   two three",
        cursor: 6,
        keys: ["d", "2", "a", "w"],
      },
      {
        name: "delimiter object searches forward on its line",
        text: "x (a) y",
        cursor: 0,
        keys: ["d", "i", "("],
      },
      {
        name: "forward delimiter object search crosses lines",
        text: "😀 lead\n(a) tail",
        cursor: 0,
        keys: ["d", "i", "("],
      },
      {
        name: "odd backslash run escapes a closing delimiter",
        text: String.raw`x (a \) b) y`,
        cursor: 4,
        keys: ["d", "i", "("],
      },
      {
        name: "even backslash run leaves a closing delimiter active",
        text: String.raw`x (a \\) b) y`,
        cursor: 4,
        keys: ["d", "i", "("],
      },
      {
        name: "quote object searches forward on its line",
        text: 'x "a" y',
        cursor: 0,
        keys: ["d", "i", '"'],
      },
      {
        name: "quote object after the last quote pair fails",
        text: 'x "a" y',
        cursor: 6,
        keys: ["d", "i", '"'],
      },
      {
        name: "odd backslash run escapes a quote",
        text: String.raw`x "a \" b" y`,
        cursor: 4,
        keys: ["d", "i", '"'],
      },
      {
        name: "even backslash run leaves a quote unescaped",
        text: String.raw`x "a \\" b`,
        cursor: 4,
        keys: ["d", "i", '"'],
      },
      {
        name: "counted percent jumps by percentage",
        text: "a\nb\nc\nd\ne",
        cursor: 0,
        keys: ["5", "0", "%"],
      },
      {
        name: "operator counted percent is linewise",
        text: "a\nb\nc\nd\ne",
        cursor: 0,
        keys: ["d", "5", "0", "%"],
      },
      {
        name: "multiline delimiter percent remains characterwise",
        text: "x (a\nb) y",
        cursor: 2,
        keys: ["d", "%"],
      },
      {
        name: "percentage above 100 fails",
        text: "a\nb\nc",
        cursor: 0,
        keys: ["1", "0", "1", "%"],
      },
      {
        name: "operator percentage above 100 fails",
        text: "a\nb\nc",
        cursor: 0,
        keys: ["d", "1", "0", "1", "%"],
      },
      {
        name: "repeated inner prefix cancels the operator",
        text: "one two",
        cursor: 0,
        keys: ["d", "i", "i"],
      },
      {
        name: "repeated around prefix cancels the operator",
        text: "one two",
        cursor: 0,
        keys: ["d", "a", "a"],
      },
    ])
  })

  test("oracle rejects incomplete operator-pending snapshots", () => {
    expect(() =>
      runNeovim([
        { name: "incomplete delete", text: "one", cursor: 0, keys: ["d"] },
      ]),
    ).toThrow("operator-pending")
  })

  test("oracle rejects every unfinished grammar branch", () => {
    for (const testCase of [
      { name: "unfinished find", keys: ["f"] },
      { name: "unfinished replace", keys: ["r"] },
      { name: "unfinished g prefix", keys: ["g"] },
      { name: "unfinished visual find", keys: ["v", "f"] },
    ])
      expect(() =>
        runNeovim([{ ...testCase, text: "one", cursor: 0 }]),
      ).toThrow("grammar-pending")
  })

  test("implementation snapshots expose pending completion", () => {
    expect(
      runImplementation({
        name: "implementation pending delete",
        text: "one",
        cursor: 0,
        keys: ["d"],
      }).pending,
    ).toBe(true)
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
      pending: false,
    })
    expect(neovim).toEqual({
      text: "  one\n two",
      cursor: 1,
      mode: "normal",
      register: { text: "", type: "characterwise" },
      pending: false,
    })
  })
})
