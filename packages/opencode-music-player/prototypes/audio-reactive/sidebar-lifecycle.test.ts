import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createAudioPrototype } from "./tui.tsx"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function fakeChild(output: { stdout?: string; stderr?: string } = {}) {
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
        if (output.stdout)
          controller.enqueue(new TextEncoder().encode(output.stdout))
        close = () => controller.close()
      },
      cancel() {
        close = () => {}
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        if (output.stderr)
          controller.enqueue(new TextEncoder().encode(output.stderr))
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

async function fixture(output: { stdout?: string; stderr?: string } = {}) {
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
  const reads: string[][] = []
  let readOverride:
    ((signal?: AbortSignal, command?: string[]) => Promise<unknown>) | undefined
  let cleared = 0
  let selection = "cliamp"
  let confirmation = async () => true
  const context = {
    ui: {
      slot(claim: { append: string; render: () => unknown }) {
        if (claim.append === "app") claim.render()
        return () => {}
      },
      dialog: {
        clear: () => {
          cleared++
        },
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
    read: async (command, signal) => {
      reads.push(command)
      if (readOverride) return readOverride(signal, command)
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
      const child = fakeChild(output)
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
    reads,
    cleared: () => cleared,
    dispose: async () => {
      await dispose?.()
    },
    blockRead: (
      read: (signal?: AbortSignal, command?: string[]) => Promise<unknown>,
    ) => {
      readOverride = read
    },
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

test("disposal cancels only the owned confirmation wait and late consent cannot read or spawn", async () => {
  const app = await fixture()
  const asked = deferred<void>()
  const decision = deferred<boolean>()
  app.select("auto")
  await app.run("source")
  app.confirm(() => {
    asked.resolve()
    return decision.promise
  })
  const starting = app.run("start")
  await asked.promise
  const reads = app.reads.length
  let settled = false
  void starting.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  try {
    await app.dispose()
    expect(settled).toBe(true)
    decision.resolve(true)
    await starting
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(app.reads).toHaveLength(reads)
    expect(app.children).toHaveLength(0)
    expect(app.errors).toEqual([])
    expect(app.cleared()).toBe(0)
  } finally {
    decision.resolve(false)
    await starting
    await app.close()
  }
})

test("a host confirmation can reject after disposal without leaking its private error or restarting work", async () => {
  const app = await fixture()
  const asked = deferred<void>()
  const decision = deferred<boolean>()
  app.select("7")
  await app.run("source")
  app.confirm(() => {
    asked.resolve()
    return decision.promise
  })
  const starting = app.run("start")
  await asked.promise
  await app.dispose()
  decision.reject(new Error("/private/fixture/SECRET_HOST_DIALOG"))
  await starting
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(app.errors).toEqual([])
  expect(app.cleared()).toBe(0)
  expect(app.children).toHaveLength(0)
  await app.close()
})

test("disposal aborts an owned blocked metadata reader and joins its action", async () => {
  const app = await fixture()
  const entered = deferred<void>()
  let aborted = false
  app.blockRead(
    (signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(new Error("/private/fixture/SECRET_METADATA"))
          },
          { once: true },
        )
        entered.resolve()
      }),
  )
  const selecting = app.run("source")
  await entered.promise
  await app.dispose()
  await selecting
  expect(aborted).toBe(true)
  expect(app.sourceOptions).toHaveLength(0)
  expect(app.errors).toEqual([])
  await app.close()
})

test("fake CLIAMP diagnostic floods and private feature errors never enter a toast", async () => {
  const marker = "/private/fixture/SECRET_DIAGNOSTIC_PCM_PAYLOAD"
  const app = await fixture({
    stdout: `${JSON.stringify({ ok: false, error: marker })}\n`,
    stderr: marker.repeat(Math.ceil((1024 * 1024) / marker.length)),
  })
  try {
    await app.run("source")
    await app.run("start")
    await app.children[0]!.stopping
    app.children[0]!.finish()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(app.errors).toEqual([
      "Source output was invalid or could not be read",
    ])
    expect(app.errors.join("")).not.toContain(marker)
  } finally {
    await app.close()
  }
})

test("a failed parallel metadata read cannot detach its blocked sibling from disposal", async () => {
  const app = await fixture()
  const outcome = deferred<unknown>()
  app.select("auto")
  await app.run("source")
  app.blockRead(async (_, command) => {
    if (command?.[0] === "media-control") return outcome.promise
    throw new Error("/private/fixture/SECRET_FAILED_SIBLING")
  })
  await app.run("start")
  let joined = false
  const disposing = app.dispose().then(() => {
    joined = true
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(joined).toBe(false)
    outcome.reject(new Error("/private/fixture/SECRET_LATE_SIBLING"))
    await disposing
    expect(joined).toBe(true)
    expect(app.errors).toEqual(["Metadata read failed"])
    expect(app.children).toHaveLength(0)
  } finally {
    outcome.resolve({})
    await disposing
    await app.close()
  }
})

test("disposal cancels blocked capture pipes and joins a child that requires forced termination", async () => {
  const app = await fixture()
  await app.run("source")
  await app.run("start")
  const started = Date.now()
  await app.dispose()
  expect(await app.children[0]!.exited).toBe(0)
  expect(Date.now() - started).toBeLessThan(2_500)
  expect(app.children[0]!.stdout.locked).toBe(false)
  expect(app.children[0]!.stderr.locked).toBe(false)
  expect(app.errors).toEqual([])
  await app.close()
})

test("disposal joins a blocked reader and fences its late result before showing a dialog or spawning", async () => {
  const app = await fixture()
  const entered = deferred<void>()
  const outcome = deferred<unknown>()
  app.blockRead(() => {
    entered.resolve()
    return outcome.promise
  })
  const selecting = app.run("source")
  await entered.promise
  let joined = false
  const disposing = app.dispose().then(() => {
    joined = true
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(joined).toBe(false)
    outcome.resolve({ processes: [] })
    await Promise.all([selecting, disposing])
    expect(joined).toBe(true)
    expect(app.sourceOptions).toHaveLength(0)
    expect(app.children).toHaveLength(0)
  } finally {
    outcome.resolve({ processes: [] })
    await Promise.all([selecting, disposing])
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
