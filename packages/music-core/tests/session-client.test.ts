import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import net from "node:net"
import {
  MusicSessionClientError,
  createMusicSessionClient,
} from "../session/client.ts"
import {
  createFakeProvider,
  startMusicSessionServer,
} from "../session/server.ts"

test("explicit client requires a socket", async () => {
  await expect(
    createMusicSessionClient({
      socketPath: "",
      clientId: "x",
      hostKind: "test",
    }),
  ).rejects.toBeInstanceOf(MusicSessionClientError)
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
