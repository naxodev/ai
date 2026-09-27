import { describe, expect, test } from "bun:test"
import { parseKeypress } from "@opentui/core"
import { printableHostPrefix, selectVimKeyBindings } from "../host-keymap.ts"

describe("Vim host keymap", () => {
  test("terminal period events reach dot-repeat instead of falling through to prompt insertion", () => {
    const bindings = selectVimKeyBindings(new Set(), {
      respectHostPrefixes: true,
    })
    for (const sequence of [".", "\x1b[46u"]) {
      const event = parseKeypress(sequence, { useKittyKeyboard: true })
      expect(event?.name).toBe(".")
      expect(bindings.find(({ bind }) => bind === event?.name)?.key).toBe(".")
    }
  })

  test("a literal period leader remains native except while Vim awaits an operand", () => {
    const normal = selectVimKeyBindings(new Set(["."]), {
      respectHostPrefixes: true,
    })
    const pending = selectVimKeyBindings(new Set(["."]), {
      respectHostPrefixes: false,
    })
    expect(normal.some(({ bind }) => bind === ".")).toBeFalse()
    expect(pending.find(({ bind }) => bind === ".")?.key).toBe(".")
  })

  test("reserves visual entry while leaving unrelated host prefixes active", () => {
    const selected = selectVimKeyBindings(new Set(["v", "x", "ctrl+["]), {
      respectHostPrefixes: true,
    }).map(({ bind }) => bind)

    expect(selected).toContain("v")
    expect(selected).toContain("shift+v")
    expect(selected).toContain("ctrl+[")
    expect(selected).not.toContain("x")
  })

  test("leaves submission native only in layers that request it", () => {
    const native = selectVimKeyBindings(new Set(), {
      respectHostPrefixes: true,
      nativeSubmit: true,
    })
    const pending = selectVimKeyBindings(new Set(["return"]), {
      respectHostPrefixes: false,
    })

    expect(native.some(({ bind }) => bind === "return")).toBeFalse()
    expect(pending.some(({ bind }) => bind === "return")).toBeTrue()
  })

  test("keeps command indexes stable when host prefixes change", () => {
    const all = selectVimKeyBindings(new Set(), {
      respectHostPrefixes: true,
    })
    const filtered = selectVimKeyBindings(new Set(["a"]), {
      respectHostPrefixes: true,
    })

    expect(filtered.find(({ bind }) => bind === "b")?.index).toBe(
      all.find(({ bind }) => bind === "b")?.index,
    )
  })

  test("accepts both terminal spellings for the reserved line-end motion", () => {
    const selected = selectVimKeyBindings(new Set(["$", "shift+4"]), {
      respectHostPrefixes: true,
    })

    expect(
      selected.filter(({ key }) => key === "$").map(({ bind }) => bind),
    ).toEqual(["shift+4", "$"])
  })

  test("converts only printable host prefixes into insert text", () => {
    expect(printableHostPrefix("space")).toBe(" ")
    expect(printableHostPrefix("g")).toBe("g")
    expect(printableHostPrefix("ctrl+x")).toBeUndefined()
  })
})
