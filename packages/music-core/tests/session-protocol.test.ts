import { describe, expect, test } from "bun:test"
import { NdjsonFramer, FrameError } from "../session/framing.ts"
import * as Schema from "effect/Schema"
import {
  decodeHelloResult,
  decodeRequest,
  decodeServerFrame,
  LEGACY_PROTOCOL,
  negotiateHello,
  PROTOCOL,
  ProtocolErrorSchema,
} from "../session/protocol.ts"

describe("session protocol", () => {
  test("decodes a v1 hello and split/multiple frames", () => {
    expect(
      decodeRequest({
        type: "hello",
        requestId: 0,
        protocol: PROTOCOL,
        packageVersion: "0.1.0",
        clientId: "a",
        hostKind: "test",
        capabilities: ["state-replay", "transport"],
      }).type,
    ).toBe("hello")
    const frames = new NdjsonFramer(100)
    expect(frames.push('{"a":1')).toEqual([])
    expect(frames.push('}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }])
  })
  test("negotiates current and legacy ranges with deterministic capabilities", () => {
    const current = decodeRequest({
      type: "hello",
      requestId: 0,
      protocol: { major: 1, minRevision: 1, maxRevision: 9 },
      packageVersion: "0.1.0",
      clientId: "current",
      hostKind: "test",
      capabilities: ["unknown", "transport", "state-replay"],
    })
    if (current.type !== "hello") throw new Error("expected hello")
    expect(negotiateHello(current)).toMatchObject({
      protocol: { selectedRevision: PROTOCOL.maxRevision },
      capabilities: ["state-replay", "transport"],
      legacy: false,
    })
    const legacy = decodeRequest({
      type: "hello",
      requestId: 0,
      protocol: LEGACY_PROTOCOL,
      packageVersion: "0.1.0",
      clientId: "legacy",
      hostKind: "test",
      capabilities: ["state-replay"],
    })
    if (legacy.type !== "hello") throw new Error("expected hello")
    expect(negotiateHello(legacy)).toMatchObject({
      protocol: { selectedRevision: 0 },
      capabilities: ["state-replay"],
      legacy: true,
    })
  })
  test("returns structured incompatibility and rejects malformed ranges", () => {
    const incompatible = decodeRequest({
      type: "hello",
      requestId: 0,
      protocol: { major: 1, minRevision: 8, maxRevision: 9 },
      packageVersion: "0.1.0",
      clientId: "incompatible",
      hostKind: "test",
      capabilities: ["state-replay"],
    })
    if (incompatible.type !== "hello") throw new Error("expected hello")
    expect(negotiateHello(incompatible)).toMatchObject({
      code: "INCOMPATIBLE_PROTOCOL",
      details: { client: incompatible.protocol, daemon: PROTOCOL },
    })
    const majorMismatch = decodeRequest({
      type: "hello",
      requestId: 0,
      protocol: { major: 2, minRevision: 0, maxRevision: 1 },
      packageVersion: "0.1.0",
      clientId: "major-mismatch",
      hostKind: "test",
      capabilities: ["state-replay"],
    })
    if (majorMismatch.type !== "hello") throw new Error("expected hello")
    expect(negotiateHello(majorMismatch)).toMatchObject({
      code: "INCOMPATIBLE_PROTOCOL",
      details: { client: majorMismatch.protocol, daemon: PROTOCOL },
    })
    expect(() =>
      decodeRequest({
        type: "hello",
        requestId: 0,
        protocol: { major: 1, minRevision: 2, maxRevision: 1 },
        packageVersion: "0.1.0",
        clientId: "bad",
        hostKind: "test",
        capabilities: ["state-replay"],
      }),
    ).toThrow()
  })
  test("schema owns range, negotiated-result, transport, and error semantics", () => {
    expect(() =>
      decodeRequest({
        type: "hello",
        requestId: 0,
        protocol: { major: 1, minRevision: 2, maxRevision: 1 },
        packageVersion: "0.1.0",
        clientId: "bad",
        hostKind: "test",
        capabilities: ["state-replay"],
      }),
    ).toThrow()
    expect(() =>
      decodeHelloResult({
        daemonInstanceId: "daemon",
        packageVersion: "0.1.0",
        capabilities: ["state-replay"],
        protocol: {
          major: 1,
          minRevision: 0,
          maxRevision: 1,
          selectedRevision: 2,
        },
      }),
    ).toThrow()
    for (const request of [
      { type: "transport", requestId: 1, action: "seek" },
      { type: "transport", requestId: 1, action: "play", positionMs: 0 },
      { type: "transport", requestId: 1, action: "seek", positionMs: -1 },
    ])
      expect(() => decodeRequest(request)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ProtocolErrorSchema)({
        code: "INCOMPATIBLE_PROTOCOL",
        message: "no overlap",
        retryable: false,
      }),
    ).toThrow()
    expect(() =>
      decodeServerFrame({
        type: "response",
        requestId: 1,
        ok: true,
        data: {},
        error: { code: "INVALID_REQUEST", message: "no", retryable: false },
      }),
    ).toThrow()
    const frames = new NdjsonFramer()
    frames.push('{"a":1')
    expect(() => frames.end()).toThrow(FrameError)
  })
  test("rejects malformed nested server frames and both contradictory responses", () => {
    const state = {
      type: "state",
      snapshot: {
        daemonInstanceId: "daemon",
        revision: 1,
        state: {
          is_playing: false,
          progress_ms: 0,
          shuffle: false,
          repeat: "off",
          device: null,
          track: null,
          fetched_at: 1,
        },
      },
    }
    for (const frame of [
      {
        ...state,
        snapshot: {
          ...state.snapshot,
          state: { ...state.snapshot.state, progress_ms: -1 },
        },
      },
      {
        ...state,
        snapshot: {
          ...state.snapshot,
          state: {
            ...state.snapshot.state,
            track: {
              uri: "u",
              id: "i",
              name: "n",
              artists: "a",
              album: "b",
              duration_ms: -1,
            },
          },
        },
      },
      {
        ...state,
        snapshot: {
          ...state.snapshot,
          state: {
            ...state.snapshot.state,
            device: {
              id: "d",
              name: "d",
              type: "d",
              is_active: true,
              volume_percent: Infinity,
              supports_volume: false,
            },
          },
        },
      },
      {
        type: "status",
        status: { kind: "ready", provider: 1, message: "bad" },
      },
      {
        type: "response",
        requestId: 1,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "bad", retryable: false },
        data: {},
      },
    ])
      expect(() => decodeServerFrame(frame)).toThrow()
  })
  test("requires replay while tolerating additive fields", () => {
    const hello = decodeRequest({
      type: "hello",
      requestId: 0,
      protocol: { ...PROTOCOL, ignored: true },
      packageVersion: "0.1.0",
      clientId: "state-only",
      hostKind: "test",
      capabilities: ["state-replay", "future-capability"],
      ignored: true,
    })
    if (hello.type !== "hello") throw new Error("expected hello")
    expect(negotiateHello(hello)).toMatchObject({
      capabilities: ["state-replay"],
    })
    const missingReplay = { ...hello, capabilities: ["transport"] }
    expect(negotiateHello(missingReplay)).toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    })
  })
  test("retains UTF-8 decoder state across chunks", () => {
    const bytes = new TextEncoder().encode('{"title":"é"}\n')
    const split = bytes.indexOf(0xc3) + 1
    const frames = new NdjsonFramer()
    expect(frames.push(bytes.slice(0, split))).toEqual([])
    expect(frames.push(bytes.slice(split))).toEqual([{ title: "é" }])
  })
  test("rejects an oversized line before accepting its chunk", () => {
    const frames = new NdjsonFramer(8)
    expect(() => frames.push('{"value":"too long"}\n')).toThrow(FrameError)
  })
})
