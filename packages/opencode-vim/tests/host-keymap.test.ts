import { describe, expect, test } from "bun:test"
import { printableHostPrefix, selectVimKeyBindings } from "../host-keymap.ts"

describe("Vim host keymap", () => {
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

  test("converts only printable host prefixes into insert text", () => {
    expect(printableHostPrefix("space")).toBe(" ")
    expect(printableHostPrefix("g")).toBe("g")
    expect(printableHostPrefix("ctrl+x")).toBeUndefined()
  })
})
