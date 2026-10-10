import { expect, test } from "bun:test"
import {
  audioFeatureFreshness,
  type AudioFeatureFrame,
} from "../audio/schema.ts"

const frame: AudioFeatureFrame = {
  daemonInstanceId: "fixture",
  generation: 1,
  sequence: 1,
  timestampMs: 1_000,
  publishedAtMs: 1_000,
  clockDomain: "capture-monotonic",
  sampleAgeMs: 400,
  source: { kind: "cooperative", cooperativeIdentity: "fixture" },
  capabilities: {
    spectrum: "measured",
    envelope: "absent",
    channels: "absent",
  },
  spectrum: [0],
}

test("sample age accumulates socket backlog and expires at the exact deadline", () => {
  expect(audioFeatureFreshness({ frame, nowMs: 1_099 })).toBe("fresh")
  expect(audioFeatureFreshness({ frame, nowMs: 1_100 })).toBe("stale")
  expect(audioFeatureFreshness({ frame, nowMs: 1_200 })).toBe("stale")
})

test("timestamp age is an independent lower bound, not an extra backlog charge", () => {
  const timestamped = { ...frame, timestampMs: 600 }
  expect(audioFeatureFreshness({ frame: timestamped, nowMs: 1_099 })).toBe(
    "fresh",
  )
  expect(audioFeatureFreshness({ frame: timestamped, nowMs: 1_100 })).toBe(
    "stale",
  )
  expect(audioFeatureFreshness({ frame, nowMs: 999 })).toBe("stale")
})
