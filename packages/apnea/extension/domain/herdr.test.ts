import { describe, expect, test } from "bun:test"
import { looksLikeShellOnly } from "./herdr.ts"

describe("looksLikeShellOnly", () => {
  // Only a pane whose *entire* foreground is a bare shell counts as
  // harness-exited; any real process in the mix means still working.
  test("all-shell foreground → true", () => {
    expect(looksLikeShellOnly(["zsh"])).toBe(true)
    expect(looksLikeShellOnly(["-bash"])).toBe(true)
    expect(looksLikeShellOnly(["fish", "-sh"])).toBe(true)
  })

  test("mixed foreground → false", () => {
    expect(looksLikeShellOnly(["zsh", "vim"])).toBe(false)
  })

  test("empty foreground → false (an unreadable pane must not be killed)", () => {
    expect(looksLikeShellOnly([])).toBe(false)
  })
})
