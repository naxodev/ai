import { describe, expect, test } from "bun:test"
import { NdjsonFramer, FrameError } from "../session/framing.ts"
import { decodeRequest, PROTOCOL } from "../session/protocol.ts"

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
  test("rejects invalid seek and incomplete frames", () => {
    expect(() =>
      decodeRequest({
        type: "transport",
        requestId: 1,
        action: "seek",
        positionMs: -1,
      }),
    ).toThrow()
    const frames = new NdjsonFramer()
    frames.push('{"a":1')
    expect(() => frames.end()).toThrow(FrameError)
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
