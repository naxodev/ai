import { expect, test } from "bun:test"
import { daemonArguments } from "../session/music-sessiond.ts"

test("retired capture launchers cannot silently start the normal playback daemon", () => {
  for (const flag of ["--local-kaset-audio", "--local-kaset-application-audio"])
    expect(() => daemonArguments([flag])).toThrow("Unknown daemon argument")

  expect(
    daemonArguments([
      "--socket",
      "/tmp/playback.sock",
      "--idle-grace-ms",
      "5000",
    ]),
  ).toEqual({
    socketPath: "/tmp/playback.sock",
    idleGraceMs: 5000,
  })
})
