import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import net from "node:net"
import { createFakeProvider } from "../session/provider.ts"
import { startMusicSessionServer } from "../session/server.ts"
import { createMusicSessionClient } from "../session/client.ts"

test("server shutdown closes a pre-hello client", async () => {
  const socketPath = `/tmp/music-session-stalled-${process.pid}-${Date.now()}.sock`
  const provider = createFakeProvider()
  const server = await startMusicSessionServer({ socketPath }, provider)
  const socket = net.createConnection(socketPath)
  await new Promise<void>((resolve) => socket.once("connect", resolve))
  await server.close()
  await server.close()
  expect(socket.destroyed).toBe(true)
  expect(existsSync(socketPath)).toBe(false)
  expect(provider.counts.disposals).toBe(1)
  expect(provider.counts.providerDisposals).toBe(1)
})

test("server close interrupts post-hello forwarding before late provider events", async () => {
  const socketPath = `/tmp/music-session-active-${process.pid}-${Date.now()}.sock`
  const provider = createFakeProvider()
  const server = await startMusicSessionServer({ socketPath }, provider)
  const socket = net.createConnection(socketPath)
  await new Promise<void>((resolve) => socket.once("connect", resolve))
  const replay = new Promise<void>((resolve) =>
    socket.once("data", () => resolve()),
  )
  socket.write(
    `${JSON.stringify({
      type: "hello",
      requestId: 1,
      protocol: { major: 1, minor: 0 },
      packageVersion: "test",
      clientId: "active-client",
      hostKind: "test",
      capabilities: ["state-replay", "transport"],
    })}\n`,
  )
  await replay
  await server.close()
  provider.emit({
    type: "snapshot",
    state: { ...provider.state, fetched_at: 2 },
  })
  await Promise.resolve()
  expect(socket.destroyed).toBe(true)
  expect(provider.counts.disposals).toBe(1)
  expect(provider.counts.providerDisposals).toBe(1)
  expect(existsSync(socketPath)).toBe(false)
})

test("correlates an invalid request without closing the listener", async () => {
  const socketPath = `/tmp/music-session-invalid-${process.pid}-${Date.now()}.sock`
  const server = await startMusicSessionServer(
    { socketPath },
    createFakeProvider(),
  )
  const socket = net.createConnection(socketPath)
  await new Promise<void>((resolve) => socket.once("connect", resolve))
  const response = new Promise<string>((resolve) =>
    socket.once("data", (chunk: Buffer) => resolve(chunk.toString())),
  )
  socket.write('{"type":"transport","requestId":7,"action":"unknown"}\n')
  expect(JSON.parse(await response)).toMatchObject({
    type: "response",
    requestId: 7,
    ok: false,
    error: { code: "UNSUPPORTED_ACTION" },
  })
  socket.destroy()
  await server.close()
})

test("two clients share the daemon command lane", async () => {
  const socketPath = `/tmp/music-session-${process.pid}-${Date.now()}.sock`
  const provider = createFakeProvider()
  const server = await startMusicSessionServer(
    { socketPath, pollMs: { playing: 100000, paused: 100000, idle: 100000 } },
    provider,
  )
  const [one, two] = await Promise.all([
    createMusicSessionClient({ socketPath, clientId: "one", hostKind: "test" }),
    createMusicSessionClient({ socketPath, clientId: "two", hostKind: "test" }),
  ])
  await Promise.all([one.play(), two.pause()])
  expect(provider.calls).toEqual(["play", "pause"])
  one.dispose()
  two.dispose()
  await server.close()
  expect(existsSync(socketPath)).toBe(false)
})
