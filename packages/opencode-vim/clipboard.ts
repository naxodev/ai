import { spawn } from "node:child_process"

export function writeClipboard(text: string): void {
  const process = spawn("pbcopy")
  process.on("error", () => {})
  process.stdin.end(text)
}
