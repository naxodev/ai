/** Real helper subprocess checks with synthetic samples only. No tap or audio output. */
import { strict as assert } from "node:assert"
import { Effect, Exit, Fiber, Result, Schedule, Schema, Stream } from "effect"
import { localMonotonicMs } from "../audio/clock.ts"
import {
  audioVisualizationCapability,
  baselineCapabilities,
} from "../session/protocol.ts"
import {
  createMusicSessionClient,
  type MusicSessionClient,
} from "../session/client.ts"
import { startLocalAudioFixture } from "../tests/local-audio-fixture.ts"
import {
  liveNativeHelperDependencies,
  makeHelperTermination,
} from "../audio/helper-process.ts"
import { AudioFeatureDraft, audioFeatureFreshness } from "../audio/schema.ts"
import {
  buildNativeAudioHelper,
  nativeHelperPath,
} from "./build-audio-helper.ts"

async function fixture(
  scenario: string,
  options: {
    leaseMs?: number
    heartbeatMs?: number
    readOutput?: boolean
  } = {},
) {
  const child = liveNativeHelperDependencies.spawn({
    executable: nativeHelperPath,
    shell: false,
    args: [
      "--self-test",
      scenario,
      "--test-lease-ms",
      String(options.leaseMs ?? 5_000),
    ],
  })
  const terminate = await Effect.runPromise(makeHelperTermination(child))
  const watchdog = setTimeout(() => child.signal("SIGKILL"), 45_000)
  let count = 0
  let first: AudioFeatureDraft | undefined
  let latest: AudioFeatureDraft | undefined
  let diagnostics = ""
  const waiting = new Set<() => void>()
  let readFailure: unknown
  let buffer = ""
  const decoder = new TextDecoder()
  const output =
    options.readOutput === false
      ? Promise.resolve(undefined)
      : Effect.runPromise(
          child.stdout.pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                buffer += decoder.decode(chunk, { stream: true })
                let split: number
                while ((split = buffer.indexOf("\n")) >= 0) {
                  const line = buffer.slice(0, split)
                  buffer = buffer.slice(split + 1)
                  assert(
                    line.length <= 16 * 1024,
                    "feature line exceeded its bound",
                  )
                  let parsed: unknown
                  try {
                    parsed = JSON.parse(line)
                  } catch (cause) {
                    throw new Error("helper emitted malformed JSON", { cause })
                  }
                  const decoded =
                    Schema.decodeUnknownResult(AudioFeatureDraft)(parsed)
                  if (Result.isFailure(decoded))
                    throw new Error("invalid helper draft")
                  latest = decoded.success
                  first ??= latest
                  count++
                  for (const wake of waiting) wake()
                }
                assert(
                  buffer.length <= 16 * 1024,
                  "partial feature exceeded its bound",
                )
              }),
            ),
          ),
        ).then(
          () => undefined,
          (error: unknown) => {
            readFailure = error
            for (const wake of waiting) wake()
            return error
          },
        )
  const errorOutput = Effect.runPromise(
    child.stderr.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          diagnostics = (diagnostics + new TextDecoder().decode(chunk)).slice(
            0,
            4_096,
          )
        }),
      ),
    ),
  ).then(
    () => undefined,
    (error: unknown) => error,
  )
  const exitOutcome = Effect.runPromise(child.exit).then(
    (exit) => ({ ok: true as const, exit }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  let heartbeat: Fiber.Fiber<void> | undefined
  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 3_000,
  ): Promise<void> {
    if (predicate()) return
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        if (readFailure || predicate()) {
          clearTimeout(timeout)
          waiting.delete(done)
          if (readFailure) reject(readFailure)
          else resolve()
        }
      }
      const timeout = setTimeout(() => {
        waiting.delete(done)
        reject(
          new Error(`helper fixture ${scenario} timed out; ${diagnostics}`),
        )
      }, timeoutMs)
      waiting.add(done)
      done()
    })
  }
  async function exited() {
    const result = await exitOutcome
    if (!result.ok) throw result.error
    await Promise.all([output, errorOutput])
    return result.exit
  }
  try {
    await Effect.runPromise(child.ready)
    if (options.heartbeatMs !== undefined)
      heartbeat = Effect.runFork(
        child.heartbeat.pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              readFailure = error
              for (const wake of waiting) wake()
            }),
          ),
          Effect.repeat(Schedule.spaced(options.heartbeatMs)),
          Effect.asVoid,
          Effect.raceFirst(child.exit.pipe(Effect.asVoid)),
        ),
      )
  } catch (error) {
    clearTimeout(watchdog)
    await Effect.runPromise(terminate)
    await Promise.all([output, errorOutput, exitOutcome])
    throw error
  }
  return {
    child,
    waitFor,
    count: () => count,
    first: () => first,
    latest: () => latest,
    diagnostics: () => diagnostics,
    exited,
    async stopHeartbeats() {
      if (heartbeat) await Effect.runPromise(Fiber.interrupt(heartbeat))
      heartbeat = undefined
    },
    async close() {
      try {
        if (heartbeat) await Effect.runPromise(Fiber.interrupt(heartbeat))
        const result = await Effect.runPromise(terminate.pipe(Effect.exit))
        if (scenario === "startup-blocked")
          assert(
            Exit.isFailure(result),
            "hard watchdog exit claimed clean teardown",
          )
        else if (Exit.isFailure(result))
          await Effect.runPromise(Effect.failCause(result.cause))
      } finally {
        clearTimeout(watchdog)
        const outcomes = await Promise.all([output, errorOutput, exitOutcome])
        for (const outcome of outcomes.slice(0, 2)) if (outcome) throw outcome
        assert(waiting.size === 0, "fixture left unresolved frame waiters")
      }
    },
  }
}

async function checkBlockedOutput() {
  const node = Bun.which("node")
  assert(node, "the blocked-pipe fixture requires the supported Node runtime")
  // Bun can prefetch unread child stdout. Node supplies actual OS-pipe pressure.
  const child = Bun.spawn(
    [
      node,
      "-e",
      `const { spawn } = require("node:child_process")
const helper = spawn(process.argv[1], ["--self-test", "blocked-output", "--test-lease-ms", "300"], { stdio: ["pipe", "pipe", "pipe"] })
helper.stdout.pause()
let diagnostics = ""
helper.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(0, 4096) })
const heartbeat = setInterval(() => helper.stdin.write(JSON.stringify({ type: "heartbeat", clockDomain: "capture-monotonic", timestampMs: performance.now() }) + "\\n"), 100)
const deadline = setTimeout(() => helper.kill("SIGKILL"), 3000)
helper.stdin.on("error", () => clearInterval(heartbeat))
helper.on("error", () => { clearInterval(heartbeat); clearTimeout(deadline); process.exitCode = 1 })
helper.on("close", (code, signal) => { clearInterval(heartbeat); clearTimeout(deadline); console.log(JSON.stringify({ code, signal, diagnostics })) })`,
      nativeHelperPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000)
  try {
    const [out, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    assert.equal(exit, 0, error)
    const result: unknown = JSON.parse(out)
    const decoded = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.Number,
        signal: Schema.NullOr(Schema.String),
        diagnostics: Schema.String,
      }),
    )(result)
    assert.equal(decoded.code, 124)
    assert.equal(decoded.signal, null)
    assert(decoded.diagnostics.includes("output-expired"))
    console.log(
      "Passed: the native watchdog ends OS-pipe backpressure despite renewed parent leases",
    )
  } finally {
    clearTimeout(deadline)
  }
}

async function checkParentDeath() {
  const node = Bun.which("node")
  assert(node, "the parent-death fixture requires the supported Node runtime")
  const parent = Bun.spawn(
    [
      node,
      "-e",
      `const { spawn } = require("node:child_process")
const helper = spawn(process.argv[1], ["--self-test", "stream", "--test-lease-ms", "300"], { stdio: ["pipe", "pipe", "pipe"] })
const heartbeat = setInterval(() => helper.stdin.write(JSON.stringify({ type: "heartbeat", clockDomain: "capture-monotonic", timestampMs: performance.now() }) + "\\n"), 50)
const deadline = setTimeout(() => helper.kill("SIGTERM"), 3000)
helper.stderr.resume()
helper.stdin.on("error", () => clearInterval(heartbeat))
helper.on("error", () => { clearInterval(heartbeat); clearTimeout(deadline); process.exitCode = 1 })
helper.on("close", () => { clearInterval(heartbeat); clearTimeout(deadline); process.exitCode = 1 })
helper.stdout.once("data", () => {
  helper.stdout.resume()
  process.stdout.write(JSON.stringify({ pid: helper.pid }) + "\\n", () => process.exit(0))
})`,
      nativeHelperPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const deadline = setTimeout(() => parent.kill("SIGKILL"), 5_000)
  let helperPid: number | undefined
  const present = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return false
      throw error
    }
  }
  try {
    const [out, error, exit] = await Promise.all([
      new Response(parent.stdout).text(),
      new Response(parent.stderr).text(),
      parent.exited,
    ])
    assert.equal(exit, 0, error)
    const child = Schema.decodeUnknownSync(
      Schema.Struct({
        pid: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
      }),
    )(JSON.parse(out))
    helperPid = child.pid
    const until = localMonotonicMs() + 3_000
    while (present(child.pid)) {
      assert(
        localMonotonicMs() < until,
        "helper remained alive after its real parent exited",
      )
      await Bun.sleep(20)
    }
    helperPid = undefined
    console.log(
      "Passed: the helper exits after its real parent dies without sending Stop",
    )
  } finally {
    clearTimeout(deadline)
    // A failed assertion must not leave the owned synthetic helper alive.
    if (helperPid !== undefined && present(helperPid)) {
      process.kill(helperPid, "SIGKILL")
      const until = localMonotonicMs() + 3_000
      while (present(helperPid)) {
        assert(
          localMonotonicMs() < until,
          "fixture cleanup did not reap helper",
        )
        await Bun.sleep(20)
      }
    }
  }
}

async function checkDaemonStream() {
  const socketPath = `/tmp/music-local-native-${process.pid}-${crypto.randomUUID()}.sock`
  // Replace only capture with the helper's tap-free synthetic entry. Metadata
  // remains a fixture. This does not validate real Kaset attribution or consent.
  const fixture = await startLocalAudioFixture(socketPath, () =>
    liveNativeHelperDependencies.spawn({
      executable: nativeHelperPath,
      shell: false,
      args: ["--self-test", "stream"],
    }),
  )
  let client: MusicSessionClient | undefined
  let unsubscribe: (() => void) | undefined
  try {
    client = await createMusicSessionClient({
      socketPath,
      clientId: "native-synthetic",
      hostKind: "test",
      capabilities: [...baselineCapabilities, audioVisualizationCapability],
    })
    let frames = 0
    unsubscribe = client.subscribeAudioFeatures((update) => {
      if (!("type" in update)) frames++
    })
    const source = (await client.listAudioSources()).sources[0]
    assert(source, "fixture did not issue a source token")
    assert.equal((await client.startAudioCapture(source.token)).type, "started")
    const before = localMonotonicMs()
    await Bun.sleep(31_000)
    assert(localMonotonicMs() - before >= 31_000)
    assert(
      frames > 500,
      "native/daemon/client stream did not sustain its generation",
    )
    assert.equal(
      fixture.starts(),
      1,
      "the shared daemon replaced its capture helper",
    )
    client.dispose()
    await fixture.waitCapturesClosed()
    console.log(
      `Passed: real native helper, shared daemon, and client sustained ${frames} synthetic frames beyond 30 seconds; final disconnect joined cleanup`,
    )
  } finally {
    unsubscribe?.()
    client?.dispose()
    await fixture.close()
  }
}

async function main() {
  await buildNativeAudioHelper()
  for (const scenario of ["clock", "identity", "attribution"] as const) {
    const child = Bun.spawn([nativeHelperPath, "--self-test", scenario], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill("SIGKILL"), 3_000)
    try {
      const [output, error, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      assert.equal(exit, 0, error)
      assert.deepEqual(JSON.parse(output), { test: scenario, passed: true })
      console.log(
        {
          clock:
            "Passed: clock mapping keeps old samples old across delayed heartbeats",
          identity:
            "Passed: native launch and signed executable identity stay stable",
          attribution:
            "Passed: mapped-file attribution rejects foreign paths, incomplete scans, and zero-sized records",
        }[scenario],
      )
    } finally {
      clearTimeout(deadline)
    }
  }

  const long = await fixture("stream", { heartbeatMs: 2_000 })
  try {
    await long.waitFor(() => long.count() >= 2)
    const first = long.first()
    assert(first?.channels && first.envelope)
    assert(first.channels.rms[0]! > 0.17 && first.channels.rms[0]! < 0.18)
    assert.equal(first.channels.rms[1], 0)
    assert(
      first.envelope.some((bucket) => bucket.min < -0.1 && bucket.max > 0.1),
    )
    assert(Math.max(...first.spectrum) > 0.5)
    const before = localMonotonicMs()
    await Bun.sleep(31_000)
    const after = localMonotonicMs()
    assert(after - before >= 31_000)
    await long.waitFor(() => (long.latest()?.timestampMs ?? 0) > after - 500)
    assert(
      long.count() > 500,
      "renewed lease did not sustain a measured stream",
    )
    await long.stopHeartbeats()
    long.child.stopIO()
    assert.equal(
      (await long.exited()).code,
      0,
      "parent closure did not stop cleanly",
    )
    console.log(
      `Passed: renewable lease sustained ${long.count()} synthetic frames beyond 30 seconds; parent closure stopped it`,
    )
  } finally {
    await long.close()
  }

  const silence = await fixture("silence", { leaseMs: 400, heartbeatMs: 100 })
  try {
    await silence.waitFor(() => silence.count() >= 2)
    const frame = silence.latest()
    assert(frame?.channels && frame.envelope)
    assert(frame.spectrum.every((value) => value === 0))
    assert(frame.channels.rms.every((value) => value === 0))
    assert(frame.channels.peaks.every((value) => value === 0))
    assert(
      frame.envelope.every((bucket) => bucket.min === 0 && bucket.max === 0),
    )
    console.log(
      "Passed: measured silence stays zero in spectrum, envelope, and stereo levels",
    )
  } finally {
    await silence.close()
  }

  const held = await fixture("held-sample", { heartbeatMs: 100 })
  try {
    await held.waitFor(() => (held.latest()?.sampleAgeMs ?? 0) > 800)
    const frame = held.latest()
    assert(frame)
    assert.equal(
      audioFeatureFreshness({
        frame: {
          ...frame,
          daemonInstanceId: "native-fixture",
          generation: 1,
          sequence: 1,
          publishedAtMs: localMonotonicMs(),
          source: { kind: "cooperative", cooperativeIdentity: "synthetic" },
          capabilities: {
            spectrum: "measured",
            envelope: "measured",
            channels: "stereo",
          },
        },
        nowMs: localMonotonicMs(),
      }),
      "stale",
    )
    console.log(
      "Passed: repeated delivery and fresh heartbeats cannot freshen held samples",
    )
  } finally {
    await held.close()
  }

  const expired = await fixture("stream", { leaseMs: 300, heartbeatMs: 100 })
  try {
    await expired.waitFor(() => expired.count() > 0)
    await expired.stopHeartbeats()
    assert.equal((await expired.exited()).code, 124)
    assert(expired.diagnostics().includes("lease-expired"))
    console.log("Passed: capture fixture stops when the parent lease expires")
  } finally {
    await expired.close()
  }

  for (const scenario of ["startup-blocked"]) {
    const blocked = await fixture(scenario, {
      leaseMs: 300,
      heartbeatMs: 100,
      readOutput: false,
    })
    try {
      assert.equal((await blocked.exited()).code, 125)
      console.log(
        `Passed: independent watchdog ends ${scenario} despite renewed parent leases`,
      )
    } finally {
      await blocked.close()
    }
  }

  await checkBlockedOutput()
  await checkParentDeath()

  const signaled = await fixture("stream", { heartbeatMs: 100 })
  try {
    await signaled.waitFor(() => signaled.count() > 0)
    signaled.child.signal("SIGTERM")
    assert.equal((await signaled.exited()).code, 0)
    console.log("Passed: SIGTERM joins normal fixture cleanup")
  } finally {
    await signaled.close()
  }

  await checkDaemonStream()

  console.log(
    "Native helper checks passed. Synthetic input only; no audio captured or played.",
  )
}

await main()
