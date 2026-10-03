import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createAudioPrototype } from "./tui.tsx"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fakeChild() {
  const stopping = deferred<void>()
  const exit = deferred<number>()
  let close!: () => void
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    close()
    exit.resolve(0)
  }
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => controller.close()
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    }),
    exited: exit.promise,
    kill(signal: "SIGTERM" | "SIGKILL") {
      stopping.resolve()
      if (signal === "SIGKILL") finish()
    },
    stopping: stopping.promise,
    finish,
  }
}

type FixtureSource = {
  pid: number
  object: number
  bundle: string
  name: string
  runningOutput?: boolean
}

async function fixture() {
  const handlers = new Map<string, () => Promise<void>>()
  const children: ReturnType<typeof fakeChild>[] = []
  const invocations: string[][] = []
  const errors: string[] = []
  const music = { pid: 7, object: 8, bundle: "com.apple.Music", name: "Music" }
  const spotify = {
    pid: 9,
    object: 10,
    bundle: "com.spotify.client",
    name: "Spotify",
  }
  let nowPlaying = music
  let sourceList: FixtureSource[] = [music, spotify]
  let metadataOverride: Record<string, unknown> | null = null
  const caches = new Map<number, string>()
  const sourceOptions: { title: string; value: string }[][] = []
  let selection = "cliamp"
  let confirmation = async () => true
  const context = {
    ui: {
      slot(claim: { append: string; render: () => unknown }) {
        if (claim.append === "app") claim.render()
        return () => {}
      },
      dialog: {
        select: async (input: {
          options: { title: string; value: string }[]
        }) => {
          sourceOptions.push(input.options)
          return selection
        },
        confirm: () => confirmation(),
      },
      toast: {
        show(input: { message: string }) {
          errors.push(input.message)
        },
      },
    },
    keymap: {
      layer(
        factory: () => { commands: { id: string; run: () => Promise<void> }[] },
      ) {
        for (const command of factory().commands)
          handlers.set(command.id, command.run)
      },
    },
  } as unknown as Plugin.Context
  const plugin = createAudioPrototype({
    read: async (command) => {
      if (command[0] === "media-control")
        return (
          metadataOverride ?? {
            playing: true,
            processIdentifier: nowPlaying.pid,
            bundleIdentifier: nowPlaying.bundle,
          }
        )
      if (command[0] === "lsof")
        return caches.get(Number(command[command.indexOf("-p") + 1])) ?? ""
      return { processes: sourceList }
    },
    spawn: (command) => {
      const child = fakeChild()
      invocations.push(command)
      children.push(child)
      return child
    },
  })
  const dispose = await plugin.setup(context)
  const run = (name: string) => {
    const handler = handlers.get(`audio-prototype.${name}`)
    if (!handler) throw new Error(`Missing command: ${name}`)
    return handler()
  }
  return {
    run,
    children,
    invocations,
    errors,
    sourceOptions,
    sources: (next: FixtureSource[]) => {
      sourceList = next
    },
    metadata: (next: Record<string, unknown>) => {
      metadataOverride = next
    },
    cache: (pid: number, text: string) => {
      caches.set(pid, text)
    },
    select: (next: string) => {
      selection = next
    },
    confirm: (next: () => Promise<boolean>) => {
      confirmation = next
    },
    switchNowPlaying: () => {
      nowPlaying = spotify
    },
    close: async () => {
      for (const child of children) child.finish()
      await run("stop")
      await dispose?.()
    },
  }
}

test("source selection cannot overlap a helper or restart the old source during shutdown", async () => {
  const app = await fixture()
  const pending: Promise<void>[] = []
  try {
    await app.run("source")
    await app.run("start")
    app.select("7")
    const selecting = app.run("source")
    pending.push(selecting)
    await app.children[0]!.stopping
    const starting = app.run("start")
    pending.push(starting)
    // Drain the current turn's microtasks, without advancing a shutdown timer.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(app.children).toHaveLength(1)
    app.children[0]!.finish()
    await Promise.all(pending)
    expect(app.children).toHaveLength(1)
    await app.run("start")
    expect(app.invocations[1]).toContain("7")
  } finally {
    for (const child of app.children) child.finish()
    await Promise.all(pending)
    await app.close()
  }
})

test("concurrent Start commands wait for the same previous shutdown", async () => {
  const app = await fixture()
  const pending: Promise<void>[] = []
  try {
    await app.run("source")
    await app.run("start")
    pending.push(app.run("start"))
    await app.children[0]!.stopping
    pending.push(app.run("start"))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(app.children).toHaveLength(1)
    app.children[0]!.finish()
    await Promise.all(pending)
    expect(app.children).toHaveLength(2)
  } finally {
    for (const child of app.children) child.finish()
    await Promise.all(pending)
    await app.close()
  }
})

test("Auto refuses a Now Playing source that changed while confirmation was open", async () => {
  const app = await fixture()
  const asked = deferred<void>()
  const decision = deferred<boolean>()
  let starting: Promise<void> | undefined
  try {
    app.select("auto")
    await app.run("source")
    app.confirm(() => {
      asked.resolve()
      return decision.promise
    })
    starting = app.run("start")
    await asked.promise
    app.switchNowPlaying()
    decision.resolve(true)
    await starting
    expect(app.children).toHaveLength(0)
    expect(
      app.errors.some((message) =>
        message.includes("Now Playing source changed"),
      ),
    ).toBe(true)
  } finally {
    decision.resolve(false)
    await starting
    await app.close()
  }
})

const kasetApp: FixtureSource = {
  pid: 11,
  object: 12,
  bundle: "com.sertacozercan.Kaset",
  name: "Kaset",
  runningOutput: false,
}
const kasetAudio: FixtureSource = {
  pid: 13,
  object: 14,
  bundle: "com.apple.WebKit.GPU",
  name: "com.apple.WebKit.GPU",
  runningOutput: true,
}
const kasetCache =
  "p13\nftxt\nn/private/var/folders/test/cache/C/com.apple.WebKit.GPU+com.sertacozercan.Kaset/com.apple.WebKit.GPU/com.apple.metal/functions.data\n"

function configureKaset(app: Awaited<ReturnType<typeof fixture>>) {
  app.sources([kasetApp, kasetAudio])
  app.metadata({
    playing: true,
    processIdentifier: kasetApp.pid,
    bundleIdentifier: kasetApp.bundle,
  })
  app.cache(kasetAudio.pid, kasetCache)
  app.select("kaset")
}

test("Kaset selects its attributed WebKit audio process, not the silent main app or another app's helper", async () => {
  const app = await fixture()
  try {
    configureKaset(app)
    app.sources([kasetApp, kasetAudio, { ...kasetAudio, pid: 15, object: 16 }])
    app.cache(
      15,
      "n/private/var/folders/test/cache/C/com.apple.WebKit.GPU+com.example.Other/com.apple.WebKit.GPU/cache\n",
    )
    await app.run("source")
    expect(app.children).toHaveLength(0)
    expect(app.sourceOptions[0]!.some((entry) => entry.value === "11")).toBe(
      false,
    )
    expect(app.sourceOptions[0]!.some((entry) => entry.value === "13")).toBe(
      false,
    )
    await app.run("start")
    expect(app.errors).toEqual([])
    expect(app.children).toHaveLength(1)
    const invocation = app.invocations[0]!
    expect(invocation[invocation.indexOf("--pid") + 1]).toBe("13")
    expect(invocation[invocation.indexOf("--object") + 1]).toBe("14")
  } finally {
    await app.close()
  }
})

test("Kaset refuses unowned WebKit output rather than restarting a previously selected source", async () => {
  const app = await fixture()
  try {
    await app.run("source")
    configureKaset(app)
    app.cache(
      kasetAudio.pid,
      "n/private/var/folders/test/cache/C/com.apple.WebKit.GPU+com.example.Other/com.apple.WebKit.GPU/cache\n",
    )
    await app.run("source")
    await app.run("start")
    expect(app.children).toHaveLength(0)
    expect(app.errors.some((message) => message.includes("Kaset"))).toBe(true)
  } finally {
    await app.close()
  }
})

test("Kaset refuses inactive helpers so paused playback cannot be mistaken for an active capture source", async () => {
  const app = await fixture()
  try {
    configureKaset(app)
    app.sources([kasetApp, { ...kasetAudio, runningOutput: false }])
    await app.run("source")
    await app.run("start")
    expect(app.children).toHaveLength(0)
    expect(
      app.errors.some((message) => message.includes("No active Kaset")),
    ).toBe(true)
  } finally {
    await app.close()
  }
})

test("Kaset refuses ambiguous attributed helpers instead of choosing the first process", async () => {
  const app = await fixture()
  try {
    configureKaset(app)
    app.sources([kasetApp, kasetAudio, { ...kasetAudio, pid: 15, object: 16 }])
    app.cache(15, kasetCache.replace("p13", "p15"))
    await app.run("source")
    await app.run("start")
    expect(app.children).toHaveLength(0)
    expect(app.errors.some((message) => message.includes("multiple"))).toBe(
      true,
    )
  } finally {
    await app.close()
  }
})

test("Kaset rechecks attribution after confirmation so consent cannot authorize a changed helper", async () => {
  const app = await fixture()
  try {
    configureKaset(app)
    await app.run("source")
    app.confirm(async () => {
      app.cache(kasetAudio.pid, "")
      return true
    })
    await app.run("start")
    expect(app.children).toHaveLength(0)
    expect(app.errors.some((message) => message.includes("attribution"))).toBe(
      true,
    )
  } finally {
    await app.close()
  }
})

test("Kaset confirmation can be declined without starting capture", async () => {
  const app = await fixture()
  try {
    configureKaset(app)
    await app.run("source")
    app.confirm(async () => false)
    await app.run("start")
    expect(app.children).toHaveLength(0)
    expect(app.errors).toEqual([])
  } finally {
    await app.close()
  }
})

test("Kaset requires a fresh selection after its Core Audio process identity changes", async () => {
  const app = await fixture()
  try {
    configureKaset(app)
    await app.run("source")
    app.sources([kasetApp, { ...kasetAudio, object: 99 }])
    await app.run("start")
    expect(app.children).toHaveLength(0)
    expect(
      app.errors.some((message) => message.includes("identity changed")),
    ).toBe(true)
  } finally {
    await app.close()
  }
})
