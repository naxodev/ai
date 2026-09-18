import { strict as assert } from "node:assert"
import { spawn, type ChildProcess } from "node:child_process"
import { createClipboardWriter } from "../clipboard.ts"

if (process.platform !== "win32")
  throw new Error("Native Windows is required; WSL is not Windows evidence")
if (!process.argv.includes("--isolated-clipboard"))
  throw new Error(
    "Use --isolated-clipboard only on a disposable Windows desktop: this check replaces its clipboard",
  )

const children: ChildProcess[] = []
const warnings: string[] = []
const diagnostics: string[] = []
const writer = createClipboardWriter("clip", {
  timeoutMs: 10_000,
  spawn(command, args, options) {
    const child = spawn(command, [...args], {
      ...options,
      stdio: ["pipe", "ignore", "pipe"],
    })
    let errorText = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      errorText = (errorText + chunk.toString()).slice(-8192)
    })
    child.on("close", (code, signal) =>
      diagnostics.push(`exit=${code} signal=${signal} stderr=${errorText}`),
    )
    children.push(child)
    return child
  },
  warn: (message) => warnings.push(message),
})

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(25)
  }
}

try {
  const latest = "Café 音楽 🎵\nsecond line"
  writer("earlier value")
  writer(latest)
  await until(
    () =>
      children.length === 2 &&
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    "ordered provider exits",
  )
  assert.deepEqual(warnings, [], diagnostics.join("\n"))
  const read = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw))))",
    ],
    { timeout: 10_000, stdout: "pipe", stderr: "pipe" },
  )
  assert.ok(read.success, read.stderr.toString())
  assert.equal(
    Buffer.from(read.stdout.toString().trim(), "base64")
      .toString("utf8")
      .replaceAll("\r\n", "\n"),
    latest,
  )
  const count = children.length
  writer("cancel active")
  writer("drop pending")
  writer.dispose()
  writer.dispose()
  writer("after disposal")
  await until(
    () =>
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    "disposed provider exit",
  )
  assert.equal(children.length, count + 1)
  assert.deepEqual(warnings, [])
  console.log(
    "Native Windows PowerShell provider: Unicode, latest write, and disposal verified",
  )
} finally {
  writer.dispose()
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL")
  await until(
    () =>
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    "provider cleanup",
  )
}
