import { beforeAll, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { join } from "node:path"

let script = ""
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "page.ts")],
    target: "browser",
    format: "iife",
  })
  if (!build.success || build.outputs.length !== 1)
    throw new Error("Fixture build failed")
  script = await build.outputs[0]!.text()
})

function page(
  options: {
    holdResume?: boolean
    rejectResume?: boolean
    rejectClose?: boolean
  } = {},
) {
  const listeners = new Map<string, () => void>()
  const button = (id: string, disabled: boolean) => ({
    disabled,
    addEventListener(event: string, callback: () => void) {
      listeners.set(`${id}:${event}`, callback)
    },
  })
  const start = button("start", false)
  const stop = button("stop", true)
  const status = { textContent: "Ready. No tone is playing." }
  const timers = new Map<number, { callback: () => void; ms: number }>()
  let nextTimer = 0
  let milliseconds = 0
  let release: (() => void) | undefined
  const nodes: Array<{
    type: string
    starts: number[]
    stops: number[]
    disconnected: boolean
    frequency: { value: number }
    gain: { value: number }
    onended?: () => void
  }> = []
  function node(type: string) {
    const result = {
      type,
      starts: [] as number[],
      stops: [] as number[],
      disconnected: false,
      frequency: { value: 0 },
      gain: { value: 0 },
      connect() {},
      disconnect() {
        result.disconnected = true
      },
      start(time: number) {
        result.starts.push(time)
      },
      stop(time?: number) {
        result.stops.push(time ?? -1)
      },
    }
    nodes.push(result)
    return result
  }
  const contexts: FakeAudioContext[] = []
  class FakeAudioContext {
    state = "suspended"
    currentTime = 5
    destination = {}
    closed = 0
    onstatechange?: () => void
    constructor(readonly options: { sampleRate: number }) {
      contexts.push(this)
    }
    async resume() {
      if (options.rejectResume) throw new Error("declined")
      if (options.holdResume)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      if (this.state !== "closed") this.state = "running"
    }
    async close() {
      this.closed++
      if (options.rejectClose) throw new Error("cleanup")
      this.state = "closed"
    }
    createOscillator() {
      return node("oscillator")
    }
    createGain() {
      return node("gain")
    }
    createChannelMerger() {
      return node("stereo")
    }
  }
  const document = {
    visibilityState: "visible",
    querySelector(selector: string) {
      return selector === "#start"
        ? start
        : selector === "#stop"
          ? stop
          : status
    },
    addEventListener(event: string, callback: () => void) {
      listeners.set(`document:${event}`, callback)
    },
  }
  runInNewContext(script, {
    AudioContext: FakeAudioContext,
    performance: { now: () => milliseconds },
    document,
    window: {
      addEventListener(event: string, callback: () => void) {
        listeners.set(`window:${event}`, callback)
      },
    },
    setTimeout(callback: () => void, ms: number) {
      const id = ++nextTimer
      timers.set(id, { callback, ms })
      return id
    },
    clearTimeout(id: number) {
      timers.delete(id)
    },
  })
  return {
    start,
    stop,
    status,
    timers,
    nodes,
    contexts,
    document,
    click() {
      listeners.get("start:click")!()
    },
    stopNow() {
      listeners.get("stop:click")!()
    },
    hide() {
      document.visibilityState = "hidden"
      listeners.get("document:visibilitychange")!()
    },
    leave() {
      listeners.get("window:pagehide")!()
    },
    resume() {
      release!()
    },
    advance(ms: number) {
      milliseconds += ms
    },
  }
}

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test("an unrelated marker cannot start on page load or start twice", async () => {
  const fixture = page()
  expect(fixture.contexts).toHaveLength(0)
  fixture.click()
  fixture.click()
  await settle()
  expect(fixture.contexts).toHaveLength(1)
  expect(fixture.contexts[0]!.options.sampleRate).toBe(48000)
  expect(fixture.nodes[0]!.frequency.value).toBe(2113)
  expect(fixture.nodes[1]!.gain.value).toBe(0.1)
  expect(fixture.nodes[0]!.starts).toEqual([5])
  expect(fixture.nodes[0]!.stops).toEqual([20])
  expect([...fixture.timers.values()].map((value) => value.ms)).toEqual([15000])
  fixture.stopNow()
  await settle()
  fixture.click()
  expect(fixture.contexts).toHaveLength(1)
  expect(fixture.contexts[0]!.closed).toBe(1)
  expect(fixture.nodes.every((value) => value.disconnected)).toBe(true)
})

test("a delivered wall timer fences a pending resume", async () => {
  const fixture = page({ holdResume: true })
  fixture.click()
  expect(fixture.nodes).toHaveLength(0)
  fixture.timers.values().next().value!.callback()
  fixture.resume()
  await settle()
  expect(fixture.nodes).toHaveLength(0)
  expect(fixture.contexts[0]!.state).toBe("closed")
  expect(fixture.status.textContent).toBe("Finished.")
})

test("elapsed time fences a late resume even before the wall timer is delivered", async () => {
  const fixture = page({ holdResume: true })
  fixture.click()
  fixture.advance(16000)
  fixture.resume()
  await settle()
  expect(fixture.nodes).toHaveLength(0)
  expect(fixture.contexts[0]!.state).toBe("closed")
  expect(fixture.timers.size).toBe(0)
  expect(fixture.status.textContent).toBe("Stopped before playback.")
})

test("startup time reduces the scheduled audio duration instead of adding another fifteen seconds", async () => {
  const fixture = page({ holdResume: true })
  fixture.click()
  fixture.advance(10000)
  fixture.resume()
  await settle()
  expect(fixture.nodes[0]!.starts).toEqual([5])
  expect(fixture.nodes[0]!.stops).toEqual([10])
  fixture.stopNow()
  await settle()
  expect(fixture.contexts[0]!.closed).toBe(1)
})

test("leaving or hiding the source stops it instead of silently resuming", async () => {
  for (const action of ["hide", "leave"] as const) {
    const fixture = page()
    fixture.click()
    await settle()
    fixture[action]()
    await settle()
    expect(fixture.status.textContent).toBe("Stopped.")
    expect(fixture.timers.size).toBe(0)
    expect(fixture.nodes.every((value) => value.disconnected)).toBe(true)
    expect(fixture.contexts[0]!.closed).toBe(1)
  }
})

test("an interrupted audio context cannot resume the marker after the case ends", async () => {
  const fixture = page()
  fixture.click()
  await settle()
  fixture.contexts[0]!.state = "suspended"
  fixture.contexts[0]!.onstatechange!()
  await settle()
  expect(fixture.nodes.every((value) => value.disconnected)).toBe(true)
  expect(fixture.status.textContent).toBe("Stopped after audio interruption.")
})

test("startup failure stays visible and spends the single start", async () => {
  const fixture = page({ rejectResume: true })
  fixture.click()
  await settle()
  fixture.click()
  expect(fixture.status.textContent).toBe(
    "Audio could not start. Close this tab.",
  )
  expect(fixture.nodes).toHaveLength(0)
  expect(fixture.contexts).toHaveLength(1)
  expect(fixture.contexts[0]!.closed).toBe(1)
})

test("cleanup failure cannot look like a clean source stop", async () => {
  const fixture = page({ rejectClose: true })
  fixture.click()
  await settle()
  fixture.stopNow()
  await settle()
  expect(fixture.status.textContent).toBe(
    "Audio cleanup failed. Close this tab.",
  )
  expect(fixture.nodes.every((value) => value.disconnected)).toBe(true)
  expect(fixture.start.disabled).toBe(true)
})
