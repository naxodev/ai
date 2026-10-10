import { expect, test } from "bun:test"
import { frame, render } from "./run.ts"

test("CLIAMP BarsDot keeps its real spectrum available to both bar renderers", () => {
  // CLIAMP 2.3.0 sends this exact mode name. It is a spectrum consumer, not a
  // raw-sample style with potentially stale exported bands.
  const bands = [0.855, 0.4, 0]
  const signal = frame({ ok: true, visualizer: "BarsDot", bands })
  expect(signal).not.toBeNull()
  if (!signal) throw new Error("Valid CLIAMP BarsDot spectrum was rejected")
  expect(signal.bands).toEqual(bands)
  for (const style of ["spectrum", "mirror"] as const)
    expect(render(signal, style, 24, 6).join("\n")).toContain("█")
  expect(render(signal, "scope", 24, 6)[0]).toContain("Unavailable")
})

test("raw-sample source modes remain rejected instead of showing stale spectrum", () => {
  for (const visualizer of ["Wave", "Scope", "Stereo", "Heartbeat"])
    expect(frame({ ok: true, visualizer, bands: [0.8, 0.4] })).toBeNull()
})

test("failed CLIAMP responses cannot masquerade as valid signal frames", () => {
  expect(frame({ ok: false, visualizer: "Bars", bands: [0.8, 0.4] })).toBeNull()
})

test("the compact scope uses measured amplitude and stays blank for silence", () => {
  const quiet = { bands: [0], waveform: [[0, 0]] }
  const active = { bands: [0], waveform: [[-0.5, 0.5]] }
  expect(render(quiet, "scope", 24, 1).join("").trim()).toBe("")
  expect(render(active, "scope", 24, 1).join("").trim()).not.toBe("")
})
