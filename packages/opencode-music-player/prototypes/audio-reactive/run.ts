/** LOCAL PROTOTYPE: real player feeds, no published plugin or config changes. */
import { mkdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"

const directory = import.meta.dir
const binary = join(directory, "dist/audio-probe")
const sdk =
  "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
const compiler =
  "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"
export const styles = ["spectrum", "mirror", "scope", "meters"] as const
const cliampSpectrumModes = ["Bars", "BarsDot", "Mirror", "ClassicPeak"]
export type Style = (typeof styles)[number]
export type Frame = {
  bands: number[]
  waveform?: number[][]
  rms?: number[]
  peaks?: number[]
  visualizer?: string
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000)
  try {
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${error}`)
    return out
  } finally {
    clearTimeout(timeout)
  }
}

export async function build() {
  if (process.platform !== "darwin")
    throw new Error("Native capture prototype requires macOS")
  await mkdir(join(directory, "dist"), { recursive: true })
  const stagedBinary = `${binary}.${process.pid}`
  try {
    await command([
      compiler,
      "-sdk",
      sdk,
      "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.2`,
      "-swift-version",
      "5",
      "-warnings-as-errors",
      "-O",
      join(directory, "AudioProbe.swift"),
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      join(directory, "Info.plist"),
      "-o",
      stagedBinary,
    ])
    await command([
      "codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      "dev.naxo.music-audio-prototype",
      stagedBinary,
    ])
    // Publish a completely signed inode, never modify a running helper's file.
    await rename(stagedBinary, binary)
  } finally {
    await rm(stagedBinary, { force: true })
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function numbers(
  value: unknown,
  max: number,
  minValue = 0,
  maxValue = 1,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= max &&
    value.every(
      (n: unknown) =>
        typeof n === "number" &&
        Number.isFinite(n) &&
        n >= minValue &&
        n <= maxValue,
    )
  )
}

export function frame(value: unknown): Frame | null {
  if (!record(value) || value.ok === false || !numbers(value.bands, 128))
    return null
  // CLIAMP raw-sample styles can leave the exported spectrum stale.
  const visualizer =
    typeof value.visualizer === "string" ? value.visualizer : undefined
  if (visualizer && !cliampSpectrumModes.includes(visualizer)) return null
  const result: Frame = {
    bands: value.bands,
    ...(visualizer ? { visualizer } : {}),
  }
  if (
    numbers(value.rms, 2, 0, 8) &&
    numbers(value.peaks, 2, 0, 8) &&
    value.rms.length === 2 &&
    value.peaks.length === 2
  ) {
    result.rms = value.rms
    result.peaks = value.peaks
  }
  if (
    Array.isArray(value.waveform) &&
    value.waveform.length > 0 &&
    value.waveform.length <= 128 &&
    value.waveform.every(
      (pair: unknown) =>
        numbers(pair, 2, -1, 1) && pair.length === 2 && pair[0]! <= pair[1]!,
    )
  )
    result.waveform = value.waveform as number[][]
  return result
}

export function render(
  value: Frame,
  style: Style,
  width: number,
  height: number,
): string[] {
  const bars = Array.from(
    { length: width },
    (_, x) => value.bands[Math.floor((x * value.bands.length) / width)] ?? 0,
  )
  const glyphs = " ▁▂▃▄▅▆▇█"
  if (style === "scope") {
    if (!value.waveform)
      return ["Unavailable: this feed has no time-domain samples."]
    // A single row cannot plot signed displacement. Show a labeled amplitude
    // envelope instead of drawing an identical full-height line for silence.
    if (height === 1)
      return [
        Array.from({ length: width }, (_, x) => {
          const pair = value.waveform![
            Math.floor((x * value.waveform!.length) / width)
          ] ?? [0, 0]
          return glyphs[
            Math.round(Math.max(Math.abs(pair[0]!), Math.abs(pair[1]!)) * 8)
          ]
        }).join(""),
      ]
    return Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => {
        const pair = value.waveform![
          Math.floor((x * value.waveform!.length) / width)
        ] ?? [0, 0]
        const high = Math.round(((1 - pair[1]!) * (height - 1)) / 2)
        const low = Math.round(((1 - pair[0]!) * (height - 1)) / 2)
        return y >= high && y <= low
          ? "│"
          : y === Math.floor(height / 2)
            ? "─"
            : " "
      }).join(""),
    )
  }
  if (style === "meters") {
    if (!value.rms || !value.peaks)
      return ["Unavailable: this feed has no stereo levels."]
    if (height === 1) {
      const channelWidth = Math.max(2, Math.floor((width - 3) / 2))
      return [
        value.rms
          .map((rms, channel) => {
            const dB = 20 * Math.log10(Math.max(0.000_001, rms))
            const filled = Math.round(
              Math.max(0, Math.min(1, (dB + 60) / 60)) * (channelWidth - 1),
            )
            return `${channel ? "R" : "L"}${"█".repeat(filled)}${"░".repeat(channelWidth - 1 - filled)}`
          })
          .join(" "),
      ]
    }
    return value.rms.map((rms, channel) => {
      const dB = 20 * Math.log10(Math.max(0.000_001, rms))
      const length = Math.round(
        Math.max(0, Math.min(1, (dB + 60) / 60)) * (width - 20),
      )
      return `${channel ? "R" : "L"} ${"█".repeat(length)}${"░".repeat(Math.max(0, width - 20 - length))} ${dB.toFixed(1)} dBFS`
    })
  }
  if (height === 1)
    return [bars.map((level) => glyphs[Math.round(level * 8)]).join("")]
  return Array.from({ length: height }, (_, y) =>
    bars
      .map((level) => {
        const span =
          style === "mirror"
            ? height / 2 - Math.abs(y - (height - 1) / 2)
            : height - y
        const threshold =
          style === "mirror" ? 1 - span / (height / 2) : span / height
        return level > 0 && level >= threshold ? "█" : " "
      })
      .join(""),
  )
}

async function main() {
  if (process.argv.includes("--build")) {
    await build()
    console.log(`Built ${binary}`)
    return
  }
  if (process.argv.includes("--list")) {
    await build()
    console.log(await command([binary, "--list"]))
    return
  }
  if (process.argv.includes("--self-test")) {
    await build()
    const events = (await command([binary, "--self-test"]))
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line) as unknown)
    const signals = events
      .map(frame)
      .filter((signal): signal is Frame => signal !== null)
    const tone = signals[0]
    const silence = signals[1]
    const strongest = tone ? Math.max(...tone.bands) : 0
    const strongestBand = tone?.bands.indexOf(strongest) ?? -1
    if (
      signals.length !== 2 ||
      !tone?.rms ||
      tone.rms[0]! < 0.17 ||
      tone.rms[0]! > 0.18 ||
      tone.rms[1] !== 0 ||
      strongest < 0.5 ||
      (strongestBand !== 12 && strongestBand !== 13) ||
      tone.bands[0]! >= strongest - 0.2 ||
      tone.bands[23]! >= strongest - 0.2 ||
      !tone.waveform?.some((pair) => pair[0]! < -0.1 && pair[1]! > 0.1) ||
      !silence ||
      silence.bands.some((n) => n !== 0) ||
      !silence.rms ||
      silence.rms.some((n) => n !== 0) ||
      !silence.peaks ||
      silence.peaks.some((n) => n !== 0) ||
      silence.waveform?.some((pair) => pair.some((n) => n !== 0))
    )
      throw new Error("DSP fixture failed: tone/stereo separation/silence")
    console.log("Synthetic DSP check passed; this is not live audio capture.")
    return
  }
  const source = argument("--source") ?? "cliamp"
  if (!["cliamp", "native"].includes(source))
    throw new Error("Choose --source cliamp or native")
  const seconds = Number(
    argument("--seconds") ??
      (source === "native"
        ? "15"
        : process.argv.includes("--check")
          ? "5"
          : "0"),
  )
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > 30 ||
    (source === "native" && seconds === 0)
  )
    throw new Error("Capture duration must be 1–30 seconds")
  const pid = argument("--pid")
  if (source === "native" && (!pid || !/^\d+(,\d+){0,7}$/.test(pid)))
    throw new Error(
      "Native mode requires explicit --pid PID[,PID]; use --list first",
    )
  const requestedStyle = argument("--style") ?? "spectrum"
  if (!styles.includes(requestedStyle as Style))
    throw new Error("Choose spectrum, mirror, scope, or meters")
  let style = requestedStyle as Style
  if (source === "native") await build()
  const child = Bun.spawn(
    source === "native"
      ? [binary, "--pid", pid!, "--seconds", String(seconds)]
      : ["cliamp", "visstream", "--fps", "20"],
    { stdout: "pipe", stderr: "pipe" },
  )
  let status = "Waiting for a real source frame"
  let latest: Frame | null = null
  let lastFrame = 0
  let received = 0
  let nonzero = 0
  let closed = false
  let sourceError: string | undefined
  let buffer = ""
  const decoder = new TextDecoder()
  const headless = !process.stdout.isTTY || process.argv.includes("--check")
  const previousRaw = process.stdin.isRaw
  const stop = () => {
    closed = true
    child.kill("SIGTERM")
  }
  const key = (data: Buffer) => {
    const input = data.toString()
    if (input === "q" || input === "\u0003") stop()
    if (input === "v")
      style = styles[(styles.indexOf(style) + 1) % styles.length]!
  }
  const deadline = seconds
    ? setTimeout(stop, (seconds + (source === "native" ? 3 : 0)) * 1000)
    : undefined
  const killDeadline = seconds
    ? setTimeout(() => child.kill("SIGKILL"), (seconds + 5) * 1000)
    : undefined
  const diagnostics = new Response(child.stderr).text()
  const paint = () => {
    if (headless || closed) return
    const width = Math.max(24, Math.min(72, (process.stdout.columns || 80) - 4))
    const height = (process.stdout.rows || 24) >= 16 ? 6 : 1
    const current = latest
    const lines =
      current && Date.now() - lastFrame < 500
        ? render(current, style, width, height)
        : ["No fresh signal; not generating animation."]
    const safeStatus = status
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .slice(0, 160)
    process.stdout.write(
      `\x1b[H\x1b[2JLOCAL AUDIO PROTOTYPE — ${source}\n${style}${style === "scope" && height === 1 ? " (amplitude envelope)" : ""} | ${safeStatus}\n\n\x1b[38;2;122;162;247m${lines.join("\n")}\x1b[0m\n\nv: cycle styles | q: stop | no playback controls\n`,
    )
  }
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    if (!headless) {
      process.stdout.write("\x1b[?1049h\x1b[?25l")
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true)
        process.stdin.on("data", key)
        process.stdin.resume()
      }
      timer = setInterval(paint, 50)
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      if (buffer.length > 64 * 1024)
        throw new Error("Source line exceeded its bound")
      let split: number
      while ((split = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, split)
        buffer = buffer.slice(split + 1)
        if (!line) continue
        const event: unknown = JSON.parse(line)
        const next = frame(event)
        if (next) {
          latest = next
          lastFrame = Date.now()
          received++
          if (next.bands.some((n) => n > 0)) nonzero++
          status = next.visualizer
            ? `CLIAMP export: ${next.visualizer}`
            : "Native callbacks received"
        } else if (record(event)) {
          latest = null
          lastFrame = 0
          status =
            typeof event.message === "string"
              ? event.message
              : typeof event.error === "string"
                ? event.error
                : typeof event.visualizer === "string"
                  ? cliampSpectrumModes.includes(event.visualizer)
                    ? `Invalid spectrum data from CLIAMP mode ${event.visualizer}`
                    : `Unsupported CLIAMP mode ${event.visualizer}; use ${cliampSpectrumModes.join(", ")}`
                  : String(event.state ?? "Invalid feature frame")
          if (event.type === "error" || event.ok === false) sourceError = status
        }
      }
      if (closed) break
    }
    const exit = await child.exited
    const error = (await diagnostics).trim()
    if (error && !closed) throw new Error(error)
    if (headless)
      console.log(
        JSON.stringify({
          source,
          framesReceived: received,
          nonzeroFeatureFrames: nonzero,
          status,
          exit,
        }),
      )
    if (
      sourceError ||
      (!closed && exit !== 0) ||
      (!received && (process.argv.includes("--check") || !closed))
    )
      process.exitCode = 1
  } finally {
    closed = true
    child.kill("SIGTERM")
    if (timer) clearInterval(timer)
    if (deadline) clearTimeout(deadline)
    if (killDeadline) clearTimeout(killDeadline)
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    process.stdin.off("data", key)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(previousRaw ?? false)
      process.stdin.pause()
    }
    if (!headless) process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l")
    const cleanupDeadline = setTimeout(() => child.kill("SIGKILL"), 1_000)
    try {
      await child.exited
      await diagnostics
    } finally {
      clearTimeout(cleanupDeadline)
    }
  }
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
