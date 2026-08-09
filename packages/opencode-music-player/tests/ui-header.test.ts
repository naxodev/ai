import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const uiSource = readFileSync(join(import.meta.dir, "../ui.tsx"), "utf8")

// Why: the sidebar header duplicated playback state already shown by the
// transport control, wasting vertical space. Transport is the single
// playback-state affordance; do not reintroduce separate status chrome.

test("SidebarPlayer has no redundant Now playing header chrome", () => {
  // Header chrome must stay gone
  expect(uiSource).not.toContain("Now playing")
  expect(uiSource).not.toMatch(/\bStatusPill\b/)
  expect(uiSource).not.toMatch(/\bdotOn\b/)
  expect(uiSource).not.toMatch(/\bdotOff\b/)
  // Standalone status labels used only by the old pill
  expect(uiSource).not.toMatch(/"playing"/)
  expect(uiSource).not.toMatch(/"paused"/)
})

test("SidebarPlayer keeps transport as the playback-state affordance", () => {
  expect(uiSource).toMatch(/Icon\.pause/)
  expect(uiSource).toMatch(/Icon\.play/)
  expect(uiSource).toMatch(/active=\{playing\(\)\}/)
})

test("SidebarPlayer keeps loading, empty, and error feedback", () => {
  expect(uiSource).toContain("Syncing…")
  expect(uiSource).toContain("Nothing playing")
  expect(uiSource).toMatch(/props\.state\.error/)
})
