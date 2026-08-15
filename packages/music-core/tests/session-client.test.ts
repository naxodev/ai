import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import net from "node:net"
import { NdjsonFramer } from "../session/framing.ts"
import {
  MusicSessionClientError,
  connectOrStartMusicSession,
  createMusicSessionClient,
  launchManagedMusicSessionDaemon,
  discoverMusicSession,
} from "../session/client.ts"
import {
  acquireStartupMarkerLease,
  MusicSessionRuntimeError,
  prepareManagedRuntimeDirectory,
  resolveMusicSessionRuntimePaths,
  resolveMusicSessionStartup,
} from "../session/config.ts"
import { Effect } from "effect"
import {
  createFakeProvider,
  startMusicSessionServer,
} from "../session/server.ts"

test("startup timing resolves through the tagged config boundary", async () => {
  await expect(
    Effect.runPromise(
      resolveMusicSessionStartup({
        attempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 40,
      }),
    ),
  ).resolves.toEqual({ attempts: 3, initialDelayMs: 10, maxDelayMs: 40 })
  for (const [settings, setting] of [
    [{ attempts: 0 }, "startup.attempts"],
    [{ initialDelayMs: Number.POSITIVE_INFINITY }, "startup.initialDelayMs"],
    [{ initialDelayMs: 41, maxDelayMs: 40 }, "startup.maxDelayMs"],
  ] as const) {
    await expect(
      Effect.runPromise(resolveMusicSessionStartup(settings)),
    ).rejects.toMatchObject({
      _tag: "MusicSession.ConfigError",
      setting,
    })
  }
})

type ScriptedFrame = { type: string; requestId: number; action?: string }
type ScriptedDaemon = {
  readonly path: string
  connections(): number
  accepted(): Promise<void>
  received(count: number): Promise<ScriptedFrame[]>
  frames(): ScriptedFrame[]
  closed(): Promise<void>
  send(frame: unknown): void
  write(...chunks: string[]): Promise<void>
  end(): void
  destroy(): void
  error(): void
  close(): Promise<void>
}

async function startScriptedDaemon(helloTail = ""): Promise<ScriptedDaemon> {
  const path = `/tmp/music-session-scripted-${process.pid}-${randomUUID()}.sock`
  const received: ScriptedFrame[] = []
  const receivedWaiters = new Set<{
    readonly count: number
    readonly resolve: () => void
    readonly reject: (cause: Error) => void
  }>()
  let socket: net.Socket | undefined
  let connectionCount = 0
  let terminal: Error | undefined
  let resolveAccepted: () => void = () => {}
  const accepted = new Promise<void>((resolve) => (resolveAccepted = resolve))
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve))
  const rejectWaiters = (cause: Error) => {
    terminal ??= cause
    for (const waiter of receivedWaiters) waiter.reject(terminal)
    receivedWaiters.clear()
  }
  const server = net.createServer((connection) => {
    connectionCount++
    socket = connection
    connection.on("error", rejectWaiters)
    connection.once("close", () => {
      rejectWaiters(new Error("scripted daemon socket closed"))
      resolveClosed()
    })
    resolveAccepted()
    const framer = new NdjsonFramer()
    connection.on("data", (chunk) => {
      for (const frame of framer.push(chunk) as ScriptedFrame[]) {
        received.push(frame)
        for (const waiter of [...receivedWaiters])
          if (received.length >= waiter.count) {
            receivedWaiters.delete(waiter)
            waiter.resolve()
          }
        if (frame.type === "hello")
          connection.write(
            `${JSON.stringify({ type: "response", requestId: 0, ok: true, data: { daemonInstanceId: "daemon", packageVersion: "test", protocol: { major: 1, minRevision: 0, maxRevision: 1, selectedRevision: 1 }, capabilities: ["state-replay", "transport"] } })}\n${helloTail}`,
          )
      }
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(path, resolve)
    })
  } catch (cause) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(path, { force: true })
    throw cause
  }
  return {
    path,
    connections: () => connectionCount,
    accepted: () => accepted,
    received: async (count) => {
      if (received.length < count) {
        if (terminal) throw terminal
        await new Promise<void>((resolve, reject) =>
          receivedWaiters.add({ count, resolve, reject }),
        )
      }
      return received.slice(0, count)
    },
    frames: () => [...received],
    closed: () => closed,
    send: (frame) => socket!.write(`${JSON.stringify(frame)}\n`),
    write: async (...chunks) => {
      for (const chunk of chunks)
        await new Promise<void>((resolve, reject) =>
          socket!.write(chunk, (error) => (error ? reject(error) : resolve())),
        )
    },
    end: () => socket!.end(),
    destroy: () => socket!.destroy(),
    error: () => socket!.destroy(new Error("scripted daemon error")),
    close: async () => {
      socket?.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(path, { force: true })
    },
  }
}

test("managed launcher uses detached packaged entry and releases its child handle", async () => {
  const listeners = new Map<string, (cause?: Error) => void>()
  const removed: string[] = []
  let unrefs = 0
  let invocation:
    | {
        readonly command: string
        readonly args: readonly string[]
        readonly options: unknown
      }
    | undefined
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: process.getuid?.() ?? -1,
  })
  const launched = launchManagedMusicSessionDaemon(runtime, {
    entry: () => "/absolute/music-sessiond.js",
    spawn: (command, args, options) => {
      invocation = { command, args, options }
      return {
        once: (event, listener) => {
          listeners.set(event, listener)
        },
        off: (event) => {
          removed.push(event)
        },
        unref: () => {
          unrefs++
        },
      }
    },
  })
  await Promise.resolve()
  listeners.get("spawn")?.()
  await launched
  expect(invocation).toEqual({
    command: process.execPath,
    args: ["/absolute/music-sessiond.js"],
    options: {
      detached: true,
      stdio: "ignore",
      shell: false,
      env: { PATH: process.env.PATH ?? "" },
    },
  })
  expect(removed).toEqual(["spawn", "error"])
  expect(unrefs).toBe(1)
})

test("managed launcher reports synchronous and initial spawn failures", async () => {
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: process.getuid?.() ?? -1,
  })
  await expect(
    launchManagedMusicSessionDaemon(runtime, {
      entry: () => "/absolute/music-sessiond.js",
      spawn: () => {
        throw new Error("spawn throw")
      },
    }),
  ).rejects.toMatchObject({
    operation: "spawn",
    message: "unable to spawn music session daemon",
  })

  const listeners = new Map<string, (cause?: Error) => void>()
  const launched = launchManagedMusicSessionDaemon(runtime, {
    entry: () => "/absolute/music-sessiond.js",
    spawn: () => ({
      once: (event, listener) => {
        listeners.set(event, listener)
      },
      off: () => {},
      unref: () => {},
    }),
  })
  await Promise.resolve()
  listeners.get("error")?.(new Error("initial error"))
  await expect(launched).rejects.toMatchObject({ operation: "spawn" })
})

test("explicit client requires a socket", async () => {
  await expect(
    createMusicSessionClient({
      socketPath: "",
      clientId: "x",
      hostKind: "test",
    }),
  ).rejects.toBeInstanceOf(MusicSessionClientError)
})

test("managed runtime resolver and preparation keep a compact owner-only layout", async () => {
  const root = await mkdtemp("/tmp/music-session-runtime-")
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    expect(runtime.directory).toBe(
      `${root}/naxodev-music-${process.getuid?.() ?? -1}`,
    )
    expect(runtime.socketPath).toBe(`${runtime.directory}/s.sock`)
    expect(runtime.markerPath).toBe(`${runtime.directory}/start.lock`)
    expect(
      Buffer.byteLength(runtime.socketPath, "utf8") + 1,
    ).toBeLessThanOrEqual(104)
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    const directory = await lstat(runtime.directory)
    expect(directory.isDirectory()).toBe(true)
    expect(directory.mode & 0o077).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("managed runtime rejects wrong-mode and symlinked roots without repair", async () => {
  const root = await mkdtemp("/tmp/music-session-runtime-unsafe-")
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await chmod(runtime.directory, 0o755)
    await expect(
      Effect.runPromise(prepareManagedRuntimeDirectory(runtime)),
    ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
    expect((await lstat(runtime.directory)).mode & 0o777).toBe(0o755)

    await rm(runtime.directory, { recursive: true })
    const target = `${root}/target`
    await writeFile(target, "not a directory")
    await symlink(target, runtime.directory)
    await expect(
      Effect.runPromise(prepareManagedRuntimeDirectory(runtime)),
    ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
    expect((await lstat(runtime.directory)).isSymbolicLink()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("managed discovery rejects unsafe socket artifacts without connecting or removing them", async () => {
  for (const kind of ["file", "symlink", "wrong-mode"] as const) {
    const root = await mkdtemp(`/tmp/music-session-runtime-artifact-${kind}-`)
    try {
      const runtime = resolveMusicSessionRuntimePaths({
        root,
        uid: process.getuid?.() ?? -1,
      })
      await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
      if (kind === "symlink") {
        const target = `${root}/socket-target`
        await writeFile(target, "not a socket", { mode: 0o600 })
        await symlink(target, runtime.socketPath)
      } else if (kind === "wrong-mode") {
        await leaveStaleSocket(runtime)
        await chmod(runtime.socketPath, 0o644)
      } else {
        await writeFile(runtime.socketPath, "not a socket", { mode: 0o600 })
      }
      const before = await lstat(runtime.socketPath)
      await expect(
        discoverMusicSession({ runtime, clientId: kind, hostKind: "test" }),
      ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
      const after = await lstat(runtime.socketPath)
      expect(after.dev).toBe(before.dev)
      expect(after.ino).toBe(before.ino)
      expect(after.mode).toBe(before.mode)
      expect(
        kind === "symlink"
          ? after.isSymbolicLink()
          : kind === "wrong-mode"
            ? after.isSocket()
            : after.isFile(),
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("managed runtime rejects non-directory and simulated foreign-owned roots without repair", async () => {
  const root = await mkdtemp("/tmp/music-session-runtime-root-")
  try {
    const uid = process.getuid?.() ?? -1
    const runtime = resolveMusicSessionRuntimePaths({ root, uid })
    await writeFile(runtime.directory, "not a directory", { mode: 0o600 })
    const file = await lstat(runtime.directory)
    await expect(
      Effect.runPromise(prepareManagedRuntimeDirectory(runtime)),
    ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
    expect((await lstat(runtime.directory)).ino).toBe(file.ino)
    await rm(runtime.directory)

    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    const foreignRuntime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        lstat: (async (path) => {
          const stat = await lstat(path)
          return path === runtime.directory
            ? new Proxy(stat, {
                get(target, property, receiver) {
                  return property === "uid"
                    ? uid + 1
                    : Reflect.get(target, property, receiver)
                },
              })
            : stat
        }) as typeof lstat,
      },
    })
    const before = await lstat(runtime.directory)
    await expect(
      Effect.runPromise(prepareManagedRuntimeDirectory(foreignRuntime)),
    ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
    const after = await lstat(runtime.directory)
    expect(after.ino).toBe(before.ino)
    expect(after.mode).toBe(before.mode)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("exclusive startup marker lease has one winner and preserves replacements", async () => {
  const root = await mkdtemp("/tmp/music-session-lease-")
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    const leases = await Promise.all(
      Array.from({ length: 20 }, () => acquireStartupMarkerLease(runtime)),
    )
    const acquired = leases.filter(
      (result): result is Extract<typeof result, { type: "acquired" }> =>
        result.type === "acquired",
    )
    expect(acquired).toHaveLength(1)
    expect(leases.filter((result) => result.type === "contended")).toHaveLength(
      19,
    )
    const before = await lstat(runtime.markerPath)
    await acquired[0]!.lease.release()
    await acquired[0]!.lease.release()
    await expect(lstat(runtime.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    })

    const replacement = await acquireStartupMarkerLease(runtime)
    if (replacement.type !== "acquired") throw new Error("lease contention")
    await rm(runtime.markerPath)
    await writeFile(
      runtime.markerPath,
      JSON.stringify({
        version: 1,
        uid: runtime.uid,
        pid: process.pid,
        attemptToken: replacement.lease.attemptToken,
      }),
      { mode: 0o600 },
    )
    await chmod(runtime.markerPath, 0o600)
    const replacementDiscovery = await discoverMusicSession({
      runtime,
      ownedLease: replacement.lease,
      clientId: "replacement",
      hostKind: "test",
    })
    expect(replacementDiscovery.type).toBe("starting")
    await expect(replacement.lease.release()).rejects.toBeInstanceOf(
      MusicSessionRuntimeError,
    )
    const after = await lstat(runtime.markerPath)
    expect(before.ino).not.toBe(after.ino)
    expect(await readFile(runtime.markerPath, "utf8")).toContain(
      replacement.lease.attemptToken,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("connect-or-start acquires one marker, launches once, and returns a hello client", async () => {
  const root = await mkdtemp("/tmp/music-session-connect-start-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const provider = createFakeProvider()
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let client: Awaited<ReturnType<typeof connectOrStartMusicSession>> | undefined
  let launches = 0
  try {
    client = await connectOrStartMusicSession({
      runtime,
      clientId: "starter",
      hostKind: "test",
      launcher: async () => {
        launches++
        server = await startMusicSessionServer({ runtime }, provider)
      },
    })
    expect(launches).toBe(1)
    expect(client.daemonInstanceId).not.toBe("")
    expect(existsSync(runtime.markerPath)).toBe(false)
  } finally {
    client?.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("managed marker EPERM process checks stay conservative through the seam", async () => {
  const root = await mkdtemp("/tmp/music-session-runtime-marker-")
  try {
    const uid = process.getuid?.() ?? -1
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        processExists: () => {
          throw Object.assign(new Error("operation not permitted"), {
            code: "EPERM",
          })
        },
      },
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await writeFile(
      runtime.markerPath,
      JSON.stringify({ version: 1, uid, pid: 1, attemptToken: "attempt" }),
      { mode: 0o600 },
    )
    const found = await discoverMusicSession({
      runtime,
      clientId: "marker",
      hostKind: "test",
    })
    expect(found.type).toBe("starting")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("invalid managed markers fail closed and remain untouched", async () => {
  for (const kind of [
    "malformed",
    "oversized",
    "uid-mismatch",
    "wrong-mode",
    "symlink",
    "directory",
  ] as const) {
    const root = await mkdtemp(`/tmp/music-session-marker-${kind}-`)
    try {
      const uid = process.getuid?.() ?? -1
      const runtime = resolveMusicSessionRuntimePaths({ root, uid })
      await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
      if (kind === "directory") await mkdir(runtime.markerPath, { mode: 0o600 })
      else if (kind === "symlink") {
        const target = `${root}/marker-target`
        await writeFile(target, "marker")
        await symlink(target, runtime.markerPath)
      } else {
        await writeFile(
          runtime.markerPath,
          kind === "malformed"
            ? "not json"
            : kind === "oversized"
              ? "x".repeat(4097)
              : JSON.stringify({
                  version: 1,
                  uid: kind === "uid-mismatch" ? uid + 1 : uid,
                  pid: process.pid,
                  attemptToken: "mode",
                }),
        )
        await chmod(runtime.markerPath, kind === "wrong-mode" ? 0o644 : 0o600)
      }
      await expect(
        discoverMusicSession({ runtime, clientId: kind, hostKind: "test" }),
      ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
      const artifact = await lstat(runtime.markerPath)
      expect(kind === "symlink" ? artifact.isSymbolicLink() : true).toBe(true)
      expect(kind === "directory" ? artifact.isDirectory() : true).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("dead managed marker grants guarded idempotent cleanup", async () => {
  const root = await mkdtemp("/tmp/music-session-dead-marker-")
  try {
    const uid = process.getuid?.() ?? -1
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        processExists: () => {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" })
        },
      },
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await writeFile(
      runtime.markerPath,
      JSON.stringify({ version: 1, uid, pid: 123, attemptToken: "dead" }),
    )
    await chmod(runtime.markerPath, 0o600)
    const found = await discoverMusicSession({
      runtime,
      clientId: "dead-marker",
      hostKind: "test",
    })
    expect(found.type).toBe("stale")
    if (found.type === "stale") {
      await found.cleanup()
      await found.cleanup()
    }
    await expect(lstat(runtime.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unknown marker process errors remain starting without cleanup", async () => {
  const root = await mkdtemp("/tmp/music-session-unknown-marker-")
  try {
    const uid = process.getuid?.() ?? -1
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        processExists: () => {
          throw Object.assign(new Error("unknown process failure"), {
            code: "EIO",
          })
        },
      },
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await writeFile(
      runtime.markerPath,
      JSON.stringify({ version: 1, uid, pid: 123, attemptToken: "unknown" }),
    )
    await chmod(runtime.markerPath, 0o600)
    const found = await discoverMusicSession({
      runtime,
      clientId: "unknown-marker",
      hostKind: "test",
    })
    expect(found.type).toBe("starting")
    expect("cleanup" in found).toBe(false)
    expect((await lstat(runtime.markerPath)).isFile()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function leaveStaleSocket(
  runtime: ReturnType<typeof resolveMusicSessionRuntimePaths>,
) {
  const boundPath = `${runtime.directory}/b.sock`
  const server = net.createServer()
  let listening = false
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(boundPath, () => {
        listening = true
        resolve()
      })
    })
    await chmod(boundPath, 0o600)
    await rename(boundPath, runtime.socketPath)
    await new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause ? reject(cause) : resolve())),
    )
    listening = false
  } finally {
    if (listening)
      await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test("refused socket disappearance after the connection attempt is missing without cleanup authority", async () => {
  const root = await mkdtemp("/tmp/music-session-disappeared-")
  try {
    const uid = process.getuid?.() ?? -1
    const base = resolveMusicSessionRuntimePaths({ root, uid })
    await Effect.runPromise(prepareManagedRuntimeDirectory(base))
    await leaveStaleSocket(base)
    let socketStats = 0
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        lstat: (async (path) => {
          if (path === base.socketPath && ++socketStats > 1)
            throw Object.assign(new Error("gone"), { code: "ENOENT" })
          return lstat(path)
        }) as typeof lstat,
      },
    })
    const found = await discoverMusicSession({
      runtime,
      clientId: "disappeared",
      hostKind: "test",
    })
    expect(found.type).toBe("missing")
    expect("cleanup" in found).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refused managed socket yields guarded idempotent stale cleanup", async () => {
  const root = await mkdtemp("/tmp/music-session-stale-")
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await leaveStaleSocket(runtime)
    const discovered = await discoverMusicSession({
      runtime,
      clientId: "stale",
      hostKind: "test",
    })
    expect(discovered.type).toBe("stale")
    if (discovered.type === "stale") {
      await discovered.cleanup()
      await discovered.cleanup()
    }
    await expect(lstat(runtime.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("stale cleanup refuses a replacement artifact", async () => {
  const root = await mkdtemp("/tmp/music-session-stale-replacement-")
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await leaveStaleSocket(runtime)
    const discovered = await discoverMusicSession({
      runtime,
      clientId: "replacement",
      hostKind: "test",
    })
    expect(discovered.type).toBe("stale")
    await rm(runtime.socketPath, { force: true })
    await writeFile(runtime.socketPath, "replacement", { mode: 0o600 })
    if (discovered.type === "stale")
      await expect(discovered.cleanup()).rejects.toBeInstanceOf(
        MusicSessionRuntimeError,
      )
    expect((await lstat(runtime.socketPath)).isFile()).toBe(true)
    await rm(runtime.socketPath)
    await symlink(`${root}/target`, runtime.socketPath)
    if (discovered.type === "stale")
      await expect(discovered.cleanup()).rejects.toBeInstanceOf(
        MusicSessionRuntimeError,
      )
    expect((await lstat(runtime.socketPath)).isSymbolicLink()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("simulated foreign socket and marker ownership fail closed without cleanup", async () => {
  for (const artifact of ["socket", "marker"] as const) {
    const root = await mkdtemp(`/tmp/music-session-foreign-${artifact}-`)
    try {
      const uid = process.getuid?.() ?? -1
      const base = resolveMusicSessionRuntimePaths({ root, uid })
      await Effect.runPromise(prepareManagedRuntimeDirectory(base))
      if (artifact === "socket") await leaveStaleSocket(base)
      else {
        await writeFile(
          base.markerPath,
          JSON.stringify({
            version: 1,
            uid,
            pid: 123,
            attemptToken: "foreign",
          }),
          { mode: 0o600 },
        )
      }
      let unlinks = 0
      const runtime = resolveMusicSessionRuntimePaths({
        root,
        uid,
        dependencies: {
          lstat: (async (path) => {
            const stat = await lstat(path)
            return path ===
              (artifact === "socket" ? base.socketPath : base.markerPath)
              ? new Proxy(stat, {
                  get(target, property, receiver) {
                    return property === "uid"
                      ? uid + 1
                      : Reflect.get(target, property, receiver)
                  },
                })
              : stat
          }) as typeof lstat,
          unlink: async (path) => {
            unlinks++
            return rm(path)
          },
        },
      })
      const path = artifact === "socket" ? base.socketPath : base.markerPath
      const before = await lstat(path)
      await expect(
        discoverMusicSession({ runtime, clientId: artifact, hostKind: "test" }),
      ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
      const after = await lstat(path)
      expect(after.ino).toBe(before.ino)
      expect(after.mode).toBe(before.mode)
      expect(unlinks).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("malformed and reset managed peers stay occupied without cleanup", async () => {
  for (const mode of ["malformed", "reset"] as const) {
    const root = await mkdtemp(`/tmp/music-session-${mode}-peer-`)
    let server: net.Server | undefined
    try {
      const runtime = resolveMusicSessionRuntimePaths({
        root,
        uid: process.getuid?.() ?? -1,
      })
      await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
      let closed: Promise<void> | undefined
      server = net.createServer((socket) => {
        closed = new Promise<void>((resolve) => socket.once("close", resolve))
        if (mode === "malformed") socket.end("not json\\n")
        else socket.destroy()
      })
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(runtime.socketPath, resolve)
      })
      await chmod(runtime.socketPath, 0o600)
      const found = await discoverMusicSession({
        runtime,
        clientId: mode,
        hostKind: "test",
      })
      expect(found.type).toBe("occupied")
      expect("cleanup" in found).toBe(false)
      await closed
      expect((await lstat(runtime.socketPath)).isSocket()).toBe(true)
    } finally {
      await new Promise<void>(
        (resolve) => server?.close(() => resolve()) ?? resolve(),
      )
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("managed discovery returns a handshaken healthy client", async () => {
  const root = await mkdtemp("/tmp/music-session-discovery-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let discovered: Awaited<ReturnType<typeof discoverMusicSession>> | undefined
  try {
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    server = await startMusicSessionServer(
      { socketPath: runtime.socketPath },
      createFakeProvider(),
    )
    discovered = await discoverMusicSession({
      runtime,
      clientId: "discovery",
      hostKind: "test",
    })
    expect(discovered.type).toBe("healthy")
    if (discovered.type === "healthy") {
      expect(discovered.client.daemonInstanceId).not.toBe("")
      discovered.client.dispose()
    }
  } finally {
    if (discovered?.type === "healthy") discovered.client.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("managed discovery preserves a live incompatible daemon generation", async () => {
  const root = await mkdtemp("/tmp/music-session-incompatible-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let healthy: Awaited<ReturnType<typeof discoverMusicSession>> | undefined
  try {
    server = await startMusicSessionServer({ runtime }, createFakeProvider())
    const before = await lstat(runtime.socketPath)
    const incompatible = await discoverMusicSession({
      runtime,
      clientId: "future",
      hostKind: "test",
      protocolRange: { major: 1, minRevision: 9, maxRevision: 10 },
    })
    expect(incompatible.type).toBe("incompatible")
    if (incompatible.type === "incompatible") {
      expect(incompatible.error.details).toMatchObject({
        client: { minRevision: 9, maxRevision: 10 },
        daemon: { minRevision: 0, maxRevision: 1 },
      })
      expect("cleanup" in incompatible).toBe(false)
    }
    const after = await lstat(runtime.socketPath)
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
    healthy = await discoverMusicSession({
      runtime,
      clientId: "supported",
      hostKind: "test",
    })
    expect(healthy.type).toBe("healthy")
  } finally {
    if (healthy?.type === "healthy") healthy.client.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("healthy discovery grants cleanup only for a separately proven dead marker", async () => {
  const root = await mkdtemp("/tmp/music-session-healthy-dead-marker-")
  const uid = process.getuid?.() ?? -1
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid,
    dependencies: {
      processExists: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" })
      },
    },
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let discovered: Awaited<ReturnType<typeof discoverMusicSession>> | undefined
  try {
    server = await startMusicSessionServer({ runtime }, createFakeProvider())
    await writeFile(
      runtime.markerPath,
      JSON.stringify({ version: 1, uid, pid: 123, attemptToken: "dead" }),
      { mode: 0o600 },
    )
    await chmod(runtime.markerPath, 0o600)
    const socket = await lstat(runtime.socketPath)
    discovered = await discoverMusicSession({
      runtime,
      clientId: "dead-marker-healthy",
      hostKind: "test",
    })
    expect(discovered.type).toBe("healthy")
    if (discovered?.type === "healthy") await discovered.cleanup?.()
    await expect(lstat(runtime.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
    const after = await lstat(runtime.socketPath)
    expect([after.dev, after.ino]).toEqual([socket.dev, socket.ino])
  } finally {
    if (discovered?.type === "healthy") discovered.client.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("healthy discovery wins over an untrusted startup marker", async () => {
  const root = await mkdtemp("/tmp/music-session-marker-precedence-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let discovered: Awaited<ReturnType<typeof discoverMusicSession>> | undefined
  try {
    server = await startMusicSessionServer({ runtime }, createFakeProvider())
    await writeFile(runtime.markerPath, "not marker json")
    discovered = await discoverMusicSession({
      runtime,
      clientId: "marker-precedence",
      hostKind: "test",
    })
    expect(discovered.type).toBe("healthy")
  } finally {
    if (discovered?.type === "healthy") discovered.client.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("a valid live startup marker is starting and grants no cleanup", async () => {
  const root = await mkdtemp("/tmp/music-session-live-marker-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  try {
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await writeFile(
      runtime.markerPath,
      JSON.stringify({
        version: 1,
        uid: runtime.uid,
        pid: process.pid,
        attemptToken: "live-attempt",
      }),
    )
    await chmod(runtime.markerPath, 0o600)
    await expect(
      discoverMusicSession({
        runtime,
        clientId: "live-marker",
        hostKind: "test",
      }),
    ).resolves.toEqual({ type: "starting" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("malformed negotiated hello result fails once and destroys the socket", async () => {
  const path = `/tmp/music-session-client-invalid-${process.pid}-${randomUUID()}.sock`
  let server: net.Server | undefined
  let closed: Promise<void> | undefined
  try {
    server = net.createServer((socket) => {
      closed = new Promise((resolve) => socket.once("close", resolve))
      socket.once("data", () =>
        socket.write(
          `${JSON.stringify({
            type: "response",
            requestId: 0,
            ok: true,
            data: {
              daemonInstanceId: "daemon",
              packageVersion: "test",
              protocol: {
                major: 1,
                minRevision: 0,
                maxRevision: 1,
                selectedRevision: 2,
              },
              capabilities: ["state-replay"],
            },
          })}\n`,
        ),
      )
    })
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(path, resolve)
    })
    await expect(
      createMusicSessionClient({
        socketPath: path,
        clientId: "invalid-result",
        hostKind: "test",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await closed
  } finally {
    await new Promise<void>(
      (resolve) => server?.close(() => resolve()) ?? resolve(),
    )
    await rm(path, { force: true })
  }
})

test("hello failure response and malformed frame destroy the client socket", async () => {
  for (const [name, frame, expectedCode] of [
    [
      "failure",
      JSON.stringify({
        type: "response",
        requestId: 0,
        ok: false,
        error: {
          code: "UNSUPPORTED_CAPABILITY",
          message: "state-replay capability is required",
          retryable: false,
        },
      }),
      "UNSUPPORTED_CAPABILITY",
    ],
    ["malformed", "not json", "CONNECTION_LOST"],
  ] as const) {
    const path = `/tmp/music-session-client-${name}-${process.pid}-${randomUUID()}.sock`
    let server: net.Server | undefined
    let closed: Promise<void> | undefined
    try {
      server = net.createServer((socket) => {
        closed = new Promise((resolve) => socket.once("close", resolve))
        socket.once("data", () => socket.write(`${frame}\n`))
      })
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(path, resolve)
      })
      await expect(
        createMusicSessionClient({
          socketPath: path,
          clientId: name,
          hostKind: "test",
        }),
      ).rejects.toMatchObject({ code: expectedCode })
      await closed
    } finally {
      await new Promise<void>(
        (resolve) => server?.close(() => resolve()) ?? resolve(),
      )
      await rm(path, { force: true })
    }
  }
})

test("impossible negotiated capabilities destroy the client socket", async () => {
  for (const capabilities of [["state-replay", "future"], ["transport"]]) {
    const path = `/tmp/music-session-client-capabilities-${process.pid}-${randomUUID()}.sock`
    let server: net.Server | undefined
    let closed: Promise<void> | undefined
    try {
      server = net.createServer((socket) => {
        closed = new Promise((resolve) => socket.once("close", resolve))
        socket.once("data", () =>
          socket.write(
            `${JSON.stringify({
              type: "response",
              requestId: 0,
              ok: true,
              data: {
                daemonInstanceId: "daemon",
                packageVersion: "test",
                protocol: {
                  major: 1,
                  minRevision: 0,
                  maxRevision: 1,
                  selectedRevision: 1,
                },
                capabilities,
              },
            })}\n`,
          ),
        )
      })
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(path, resolve)
      })
      await expect(
        createMusicSessionClient({
          socketPath: path,
          clientId: "bad-capabilities",
          hostKind: "test",
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
      await closed
    } finally {
      await new Promise<void>(
        (resolve) => server?.close(() => resolve()) ?? resolve(),
      )
      await rm(path, { force: true })
    }
  }
})

test("out-of-order transport responses settle only their matching command", async () => {
  const path = `/tmp/music-session-client-requests-${process.pid}-${randomUUID()}.sock`
  let server: net.Server | undefined
  let socket: net.Socket | undefined
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  const commands: Array<{ requestId: number; action: string }> = []
  let resolveCommands: () => void = () => {}
  const receivedCommands = new Promise<void>((resolve) => {
    resolveCommands = resolve
  })
  try {
    server = net.createServer((accepted) => {
      socket = accepted
      const framer = new NdjsonFramer()
      accepted.on("data", (chunk) => {
        for (const frame of framer.push(chunk) as Array<{
          type: string
          requestId: number
          action?: string
        }>) {
          if (frame.type === "hello")
            accepted.write(
              `${JSON.stringify({ type: "response", requestId: 0, ok: true, data: { daemonInstanceId: "daemon", packageVersion: "test", protocol: { major: 1, minRevision: 0, maxRevision: 1, selectedRevision: 1 }, capabilities: ["state-replay", "transport"] } })}\n`,
            )
          else if (frame.type === "transport") {
            commands.push({ requestId: frame.requestId, action: frame.action! })
            if (commands.length === 2) resolveCommands()
            if (commands.length === 3)
              accepted.write(
                `${JSON.stringify({
                  type: "response",
                  requestId: frame.requestId,
                  ok: true,
                  data: { action: "play" },
                })}\n`,
              )
          }
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(path, resolve)
    })
    client = await createMusicSessionClient({
      socketPath: path,
      clientId: "requests",
      hostKind: "test",
    })
    await expect(client.seek(-1)).rejects.toMatchObject({
      code: "INVALID_SEEK",
    })
    const play = client.play()
    const pause = client.pause()
    await receivedCommands
    for (const command of [...commands].reverse())
      socket!.write(
        `${JSON.stringify({ type: "response", requestId: command.requestId, ok: true, data: { action: command.action } })}\n`,
      )
    await expect(play).resolves.toEqual({ action: "play" })
    await expect(pause).resolves.toEqual({ action: "pause" })
    await expect(client.next()).rejects.toMatchObject({
      code: "INDETERMINATE_COMMAND",
    })
    await expect(client.play()).rejects.toMatchObject({
      code: "CONNECTION_LOST",
    })
  } finally {
    client?.dispose()
    socket?.destroy()
    await new Promise<void>(
      (resolve) => server?.close(() => resolve()) ?? resolve(),
    )
    await rm(path, { force: true })
  }
})

test("unsolicited and duplicate responses cannot settle later requests", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "duplicates",
      hostKind: "test",
    })
    await daemon.accepted()
    await daemon.received(1)
    daemon.send({
      type: "response",
      requestId: 99,
      ok: true,
      data: { action: "play" },
    })
    const play = client.play()
    await daemon.received(2)
    daemon.send({
      type: "response",
      requestId: 1,
      ok: true,
      data: { action: "play" },
    })
    await expect(play).resolves.toEqual({ action: "play" })
    daemon.send({
      type: "response",
      requestId: 1,
      ok: true,
      data: { action: "play" },
    })
    const pause = client.pause()
    await daemon.received(3)
    daemon.send({
      type: "response",
      requestId: 2,
      ok: true,
      data: { action: "pause" },
    })
    await expect(pause).resolves.toEqual({ action: "pause" })
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("typed command failures are request-local and disposal is terminal", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "failure",
      hostKind: "test",
    })
    await daemon.accepted()
    await daemon.received(1)
    const failed = client.play()
    await daemon.received(2)
    daemon.send({
      type: "response",
      requestId: 1,
      ok: false,
      error: {
        code: "INCOMPATIBLE_PROTOCOL",
        message: "no player",
        retryable: false,
        details: {
          client: { major: 1, minRevision: 0, maxRevision: 1 },
          daemon: { major: 2, minRevision: 0, maxRevision: 1 },
        },
      },
    })
    await expect(failed).rejects.toMatchObject({
      code: "INCOMPATIBLE_PROTOCOL",
      message: "no player",
      retryable: false,
      details: {
        client: { major: 1, minRevision: 0, maxRevision: 1 },
        daemon: { major: 2, minRevision: 0, maxRevision: 1 },
      },
    })
    const pause = client.pause()
    await daemon.received(3)
    daemon.send({
      type: "response",
      requestId: 2,
      ok: true,
      data: { action: "pause" },
    })
    await expect(pause).resolves.toEqual({ action: "pause" })
    const pending = client.next()
    await daemon.received(4)
    client.dispose()
    client.dispose()
    await expect(pending).rejects.toMatchObject({ code: "DISPOSED" })
    await expect(client.play()).rejects.toMatchObject({ code: "DISPOSED" })
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("state authority and listener isolation retain only ordered daemon snapshots", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  const snapshot = (daemonInstanceId: string, revision: number) => ({
    type: "state",
    snapshot: {
      daemonInstanceId,
      revision,
      state: {
        is_playing: false,
        progress_ms: revision,
        shuffle: false,
        repeat: "off",
        device: null,
        track: null,
        fetched_at: revision,
      },
    },
  })
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "state",
      hostKind: "test",
    })
    await daemon.accepted()
    await daemon.received(1)
    const seen: number[] = []
    let resolveDelivered: () => void = () => {}
    const delivered = new Promise<void>(
      (resolve) => (resolveDelivered = resolve),
    )
    client.subscribeState(() => {
      throw new Error("listener defect")
    })
    const unsubscribe = client.subscribeState((state) => {
      seen.push(state.revision)
      if (state.revision === 5) resolveDelivered()
    })
    daemon.send(snapshot("daemon", 1))
    daemon.send(snapshot("daemon", 1))
    daemon.send(snapshot("daemon", 0))
    daemon.send(snapshot("other", 2))
    daemon.send(snapshot("daemon", 3))
    daemon.send(snapshot("daemon", 5))
    daemon.send(snapshot("daemon", 4))
    await delivered
    expect(seen).toEqual([1, 3, 5])
    expect(client.state?.revision).toBe(5)
    unsubscribe()
    unsubscribe()
    const late: number[] = []
    let resolveLate: () => void = () => {}
    const deliveredLate = new Promise<void>(
      (resolve) => (resolveLate = resolve),
    )
    client.subscribeState((state) => {
      late.push(state.revision)
      if (state.revision === 6) resolveLate()
    })
    expect(late).toEqual([5])
    daemon.send(snapshot("daemon", 6))
    await deliveredLate
    expect(seen).toEqual([1, 3, 5])
    expect(late).toEqual([5, 6])
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("connection loss races leave every admitted command indeterminate without replay", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "loss",
      hostKind: "test",
    })
    await daemon.accepted()
    await daemon.received(1)
    const play = client.play()
    const pause = client.pause()
    const frames = await daemon.received(3)
    expect(frames.map((frame) => frame.type)).toEqual([
      "hello",
      "transport",
      "transport",
    ])
    const outcomes = Promise.all(
      [play, pause].map((command) =>
        command.then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    )
    daemon.end()
    await expect(outcomes).resolves.toEqual([
      expect.objectContaining({ code: "INDETERMINATE_COMMAND" }),
      expect.objectContaining({ code: "INDETERMINATE_COMMAND" }),
    ])
    daemon.error()
    await daemon.closed()
    await expect(client.next()).rejects.toMatchObject({
      code: "CONNECTION_LOST",
    })
    expect(daemon.frames()).toEqual(frames)
    expect(daemon.connections()).toBe(1)
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("malformed transport success terminates only after indeterminate settlement", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "malformed-result",
      hostKind: "test",
    })
    await daemon.received(1)
    const pending = client.play()
    await daemon.received(2)
    daemon.send({ type: "response", requestId: 1, ok: true, data: {} })
    await expect(pending).rejects.toMatchObject({
      code: "INDETERMINATE_COMMAND",
    })
    await expect(client.pause()).rejects.toMatchObject({
      code: "CONNECTION_LOST",
    })
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("active malformed daemon data terminates once without publishing late frames", async () => {
  const state = (revision: number) => ({
    type: "state",
    snapshot: {
      daemonInstanceId: "daemon",
      revision,
      state: {
        is_playing: false,
        progress_ms: revision,
        shuffle: false,
        repeat: "off",
        device: null,
        track: null,
        fetched_at: revision,
      },
    },
  })
  const cases: ReadonlyArray<
    readonly [string, (daemon: ScriptedDaemon) => Promise<void>]
  > = [
    [
      "malformed nested status",
      (daemon) =>
        daemon.write(
          `${JSON.stringify({ type: "status", status: { kind: "ready", provider: "media-control", message: 1 } })}\n${JSON.stringify({ type: "status", status: { kind: "ready", provider: "media-control", message: "late" } })}\n`,
        ),
    ],
    [
      "malformed nested state",
      (daemon) =>
        daemon.write(
          `${JSON.stringify({ type: "state", snapshot: { ...state(2).snapshot, state: { ...state(2).snapshot.state, progress_ms: "bad" } } })}\n${JSON.stringify(state(3))}\n`,
        ),
    ],
    [
      "malformed ndjson",
      (daemon) => daemon.write(`not json\n${JSON.stringify(state(2))}\n`),
    ],
    [
      "partial frame at eof",
      async (daemon) => {
        await daemon.write('{"type":"status"')
        daemon.end()
      },
    ],
  ]
  for (const [name, injectMalformedData] of cases) {
    const daemon = await startScriptedDaemon()
    let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
    try {
      client = await createMusicSessionClient({
        socketPath: daemon.path,
        clientId: `invalid-active-${name}`,
        hostKind: "test",
      })
      await daemon.received(1)
      const states: number[] = []
      const statuses: string[] = []
      let resolveState: () => void = () => {}
      let resolveStatus: () => void = () => {}
      const deliveredState = new Promise<void>((resolve) => {
        resolveState = resolve
      })
      const deliveredStatus = new Promise<void>((resolve) => {
        resolveStatus = resolve
      })
      client.subscribeState((snapshot) => {
        states.push(snapshot.revision)
        resolveState()
      })
      client.subscribeStatus((status) => {
        statuses.push(status.message)
        resolveStatus()
      })
      daemon.send(state(1))
      await deliveredState
      daemon.send({
        type: "status",
        status: { kind: "ready", provider: "media-control", message: "before" },
      })
      await deliveredStatus
      const pending = client.play()
      await daemon.received(2)
      await injectMalformedData(daemon)
      await expect(pending).rejects.toMatchObject({
        code: "INDETERMINATE_COMMAND",
      })
      await daemon.closed()
      await expect(client.pause()).rejects.toMatchObject({
        code: "CONNECTION_LOST",
      })
      client.subscribeState((snapshot) => states.push(snapshot.revision))
      client.subscribeStatus((status) => statuses.push(status.message))
      expect(client.state?.revision).toBe(1)
      expect(client.status?.message).toBe("before")
      expect(states).toEqual([1])
      expect(statuses).toEqual(["before"])
    } finally {
      client?.dispose()
      await daemon.close()
    }
  }
})

test("disposal wins first and suppresses late daemon callbacks", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  const state = (revision: number) => ({
    type: "state",
    snapshot: {
      daemonInstanceId: "daemon",
      revision,
      state: {
        is_playing: false,
        progress_ms: revision,
        shuffle: false,
        repeat: "off",
        device: null,
        track: null,
        fetched_at: revision,
      },
    },
  })
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "dispose-first",
      hostKind: "test",
    })
    await daemon.received(1)
    const states: number[] = []
    const statuses: string[] = []
    let resolveInitialState: () => void = () => {}
    let resolveInitialStatus: () => void = () => {}
    const initialState = new Promise<void>((resolve) => {
      resolveInitialState = resolve
    })
    const initialStatus = new Promise<void>((resolve) => {
      resolveInitialStatus = resolve
    })
    client.subscribeState((snapshot) => {
      states.push(snapshot.revision)
      resolveInitialState()
    })
    client.subscribeStatus((status) => {
      statuses.push(status.message)
      resolveInitialStatus()
    })
    daemon.send(state(1))
    await initialState
    daemon.send({
      type: "status",
      status: { kind: "ready", provider: "media-control", message: "before" },
    })
    await initialStatus
    const pending = client.play()
    await daemon.received(2)
    client.dispose()
    client.dispose()
    daemon.send({
      type: "response",
      requestId: 1,
      ok: true,
      data: { action: "play" },
    })
    void daemon
      .write(
        `${JSON.stringify(state(2))}\n${JSON.stringify({ type: "status", status: { kind: "ready", provider: "media-control", message: "after" } })}\n`,
      )
      .catch(() => {})
    daemon.error()
    daemon.end()
    daemon.destroy()
    await expect(pending).rejects.toMatchObject({ code: "DISPOSED" })
    await daemon.closed()
    await expect(client.pause()).rejects.toMatchObject({ code: "DISPOSED" })
    expect(client.state?.revision).toBe(1)
    expect(client.status?.message).toBe("before")
    expect(states).toEqual([1])
    expect(statuses).toEqual(["before"])
    expect(daemon.connections()).toBe(1)
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("split and multiple status frames isolate listeners and retain command use", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "frames",
      hostKind: "test",
    })
    await daemon.received(1)
    const statuses: string[] = []
    const allStatuses: string[] = []
    let resolveStatuses: () => void = () => {}
    const delivered = new Promise<void>(
      (resolve) => (resolveStatuses = resolve),
    )
    let unsubscribe: () => void = () => {}
    unsubscribe = client.subscribeStatus((status) => {
      statuses.push(status.message)
      unsubscribe()
    })
    client.subscribeStatus(() => {
      throw new Error("listener defect")
    })
    client.subscribeStatus((status) => {
      allStatuses.push(status.message)
      if (status.message === "three") resolveStatuses()
    })
    const one = JSON.stringify({
      type: "status",
      status: { kind: "ready", provider: "media-control", message: "one" },
    })
    const two = JSON.stringify({
      type: "status",
      status: { kind: "ready", provider: "media-control", message: "two" },
    })
    const three = JSON.stringify({
      type: "status",
      status: { kind: "ready", provider: "media-control", message: "three" },
    })
    await daemon.write(one.slice(0, 9), `${one.slice(9)}\n`)
    await daemon.write(`${two}\n${three}\n`)
    await delivered
    expect(statuses).toEqual(["one"])
    expect(allStatuses).toEqual(["one", "two", "three"])
    const play = client.play()
    await daemon.received(2)
    daemon.send({
      type: "response",
      requestId: 1,
      ok: true,
      data: { action: "play" },
    })
    await expect(play).resolves.toEqual({ action: "play" })
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("hello chunk status survives the active-reader transition", async () => {
  const helloStatus = `${JSON.stringify({ type: "status", status: { kind: "ready", provider: "media-control", message: "hello" } })}\n`
  const daemon = await startScriptedDaemon(helloStatus)
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "handoff",
      hostKind: "test",
    })
    await daemon.received(1)
    expect(client.status?.message).toBe("hello")
    const replayed: string[] = []
    client.subscribeStatus((status) => replayed.push(status.message))
    expect(replayed).toEqual(["hello"])
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("explicit client exposes current negotiated revision and capabilities", async () => {
  const path = `/tmp/music-session-client-${process.pid}-${randomUUID()}.sock`
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    server = await startMusicSessionServer(
      { socketPath: path },
      createFakeProvider(),
    )
    client = await createMusicSessionClient({
      socketPath: path,
      clientId: "current",
      hostKind: "test",
    })
    expect(client.selectedRevision).toBe(1)
    expect(client.negotiatedCapabilities).toEqual(["state-replay", "transport"])
  } finally {
    client?.dispose()
    await server?.close().catch(() => {})
  }
})
