import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { daemonArguments } from "../session/music-sessiond.ts"
import { resolveMusicSessionRuntimePaths } from "../session/config.ts"
import {
  makeLocalKasetResolver,
  readLocalKasetCatalog,
} from "../audio/local-kaset.ts"
import { liveNativeHelperDependencies } from "../audio/helper-process.ts"

const entry = (pid = 42) => ({
  identity: {
    kind: "native" as const,
    processIdentifier: pid,
    launchIdentity: "100:123",
    executableIdentity: "/System/Library/WebKit/GPU|0123456789abcdef",
    coreAudioObject: "99",
  },
  runningOutput: true,
})
const observation = {
  sequence: 2,
  kind: "snapshot" as const,
  hint: { processIdentifier: 123, bundleIdentifier: "other.app" },
}
const catalog = (sources = [entry()]) => ({ sources })
const list = async (value: unknown) =>
  Effect.runPromise(makeLocalKasetResolver(() => Effect.succeed(value)).list())

describe("local-only Kaset source ownership", () => {
  test("the daemon flag requires a separate socket and never alters installed daemon defaults", () => {
    expect(daemonArguments([]).localKasetAudio).toBe(false)
    expect(() => daemonArguments(["--local-kaset-audio"])).toThrow(
      "separate explicit",
    )
    expect(() =>
      daemonArguments([
        "--local-kaset-audio",
        "--socket",
        resolveMusicSessionRuntimePaths().socketPath,
      ]),
    ).toThrow("separate explicit")
    expect(() =>
      daemonArguments([
        "--local-kaset-audio",
        "--socket",
        resolveMusicSessionRuntimePaths().socketPath.replace(
          "/tmp/",
          "/private/tmp/",
        ),
      ]),
    ).toThrow("separate explicit")
    expect(
      daemonArguments([
        "--local-kaset-audio",
        "--socket",
        "/tmp/local-kaset-fixture.sock",
      ]).localKasetAudio,
    ).toBe(true)
  })

  test("only one active attributed helper becomes a selection, with measured stereo capabilities", async () => {
    const sources = await list(catalog())
    expect(sources.availability).toBe("available")
    expect(sources.sources).toEqual([
      {
        mode: "process",
        identity: entry().identity,
        observationSequence: 0,
        attribution: "kaset-cache-v1",
        label: "Kaset (WebKit) · PID 42",
        capabilities: {
          spectrum: "measured",
          envelope: "measured",
          channels: "stereo",
        },
      },
    ])
  })

  test("ambiguity, including a silent helper, cannot choose the first PID", async () => {
    const other = { ...entry(43), runningOutput: false }
    expect((await list(catalog([entry(), other]))).sources).toEqual([])
    expect((await list(catalog([]))).sources).toEqual([])
  })

  test("pause prevents a new selection but does not revoke an already pinned process", async () => {
    let value = catalog()
    const resolver = makeLocalKasetResolver(() => Effect.succeed(value))
    const selected = (await Effect.runPromise(resolver.list())).sources[0]
    if (!selected) throw new Error("fixture did not issue a source")
    value = catalog([{ ...entry(), runningOutput: false }])
    expect((await Effect.runPromise(resolver.list())).sources).toEqual([])
    expect(await Effect.runPromise(resolver.revalidate(selected))).toEqual(
      selected,
    )
    expect(
      await Effect.runPromise(resolver.confirm(selected, observation)),
    ).toBe("same")
  })

  for (const field of [
    "launchIdentity",
    "executableIdentity",
    "coreAudioObject",
  ] as const) {
    test(`changed ${field} at the same PID cannot renew approved ownership`, async () => {
      let value = catalog()
      const resolver = makeLocalKasetResolver(() => Effect.succeed(value))
      const selected = (await Effect.runPromise(resolver.list())).sources[0]
      if (!selected) throw new Error("fixture did not issue a source")
      const replacement = entry()
      replacement.identity[field] =
        field === "launchIdentity"
          ? "101:0"
          : field === "coreAudioObject"
            ? "100"
            : "/System/Library/WebKit/GPU|abcdef12"
      value = catalog([replacement])
      expect(
        await Effect.runPromise(resolver.confirm(selected, observation)),
      ).toBe("changed")
    })
  }

  test("source loss, replacement PIDs, and lost attribution never silently rebind", async () => {
    let value = catalog()
    const resolver = makeLocalKasetResolver(() => Effect.succeed(value))
    const selected = (await Effect.runPromise(resolver.list())).sources[0]
    if (!selected) throw new Error("fixture did not issue a source")
    for (const next of [
      catalog([]),
      catalog([entry(43)]),
      catalog([entry(), entry(43)]),
    ]) {
      value = next
      expect(
        await Effect.runPromise(resolver.revalidate(selected)),
      ).toBeUndefined()
      expect(
        await Effect.runPromise(resolver.confirm(selected, observation)),
      ).toBe("unresolved")
    }
    const { attribution: _attribution, ...unapproved } = selected
    expect(
      await Effect.runPromise(resolver.revalidate(unapproved)),
    ).toBeUndefined()
  })

  for (const value of [
    null,
    { sources: [{}] },
    catalog(Array.from({ length: 33 }, () => entry())),
    catalog([
      {
        ...entry(),
        identity: { ...entry().identity, coreAudioObject: "not-an-object" },
      },
    ]),
  ]) {
    test(`invalid metadata fails closed: ${JSON.stringify(value).slice(0, 50)}`, async () => {
      expect((await list(value)).availability).toBe("unavailable")
    })
  }

  for (const script of ["process.exit(125)", "console.log('not JSON')"]) {
    test(`abnormal metadata is unavailable, not authority to capture: ${script}`, async () => {
      const resolver = makeLocalKasetResolver(() =>
        readLocalKasetCatalog({
          ...liveNativeHelperDependencies,
          verify: () => Effect.succeed(true),
          spawn: () =>
            liveNativeHelperDependencies.spawn({
              executable: process.execPath,
              args: ["-e", script],
              shell: false,
            }),
        }),
      )
      expect((await Effect.runPromise(resolver.list())).availability).toBe(
        "unavailable",
      )
    })
  }

  test("real metadata subprocesses are signature-gated and cannot request a tap", async () => {
    const seen: string[][] = []
    const dependencies = {
      ...liveNativeHelperDependencies,
      verify: () => Effect.succeed(true),
      spawn: (
        request: Parameters<typeof liveNativeHelperDependencies.spawn>[0],
      ) => {
        seen.push([...request.args])
        return liveNativeHelperDependencies.spawn({
          executable: process.execPath,
          shell: false,
          args: [
            "-e",
            `console.log(${JSON.stringify(JSON.stringify(catalog()))})`,
          ],
        })
      },
    }
    expect(
      await Effect.runPromise(readLocalKasetCatalog(dependencies)),
    ).toEqual(catalog())
    expect(seen).toEqual([["--list-kaset-sources"]])
    const resolver = makeLocalKasetResolver(() =>
      readLocalKasetCatalog({
        ...dependencies,
        verify: () => Effect.succeed(false),
      }),
    )
    expect((await Effect.runPromise(resolver.list())).availability).toBe(
      "unavailable",
    )
    expect(seen).toHaveLength(1)
  })
})
