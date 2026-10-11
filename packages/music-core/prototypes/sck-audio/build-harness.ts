/** Build only. Does not launch/register the app or change privacy permissions. */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildSckPrototype } from "./build.ts"

const directory = import.meta.dir
const contents = join(directory, "dist/Kaset SCK Permission Probe.app/Contents")
const executable = join(contents, "MacOS/Launcher")
const identifier = "dev.naxo.music.sck-matrix.20261011"
await buildSckPrototype()
await mkdir(join(contents, "MacOS"), { recursive: true })
await writeFile(
  join(contents, "Info.plist"),
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>' +
    identifier +
    "</string><key>CFBundleExecutable</key><string>Launcher</string><key>CFBundleName</key><string>Kaset SCK Permission Probe</string><key>CFBundlePackageType</key><string>APPL</string><key>NSAudioCaptureUsageDescription</key><string>Test bounded Kaset audio visualization after explicit approval.</string></dict></plist>",
)
const source = [
  "import Cocoa",
  "import Darwin",
  "final class Harness: NSObject, NSApplicationDelegate {",
  "var window: NSWindow!",
  "var child: Process?",
  'let label = NSTextField(labelWithString: "Each approved probe lasts at most 15 seconds. A stage button starts capture.")',
  "func applicationDidFinishLaunching(_ notification: Notification) {",
  "window = NSWindow(contentRect: NSRect(x:0,y:0,width:620,height:230),styleMask:[.titled,.closable,.miniaturizable],backing:.buffered,defer:false)",
  'window.title = "Kaset SCK Permission Probe"',
  "let stack = NSStackView(); stack.orientation = .vertical; stack.spacing = 16",
  "label.maximumNumberOfLines = 3; label.preferredMaxLayoutWidth = 560; stack.addArrangedSubview(label)",
  'for title in ["deny", "allow", "revoke"] { stack.addArrangedSubview(NSButton(title:title,target:self,action:#selector(runStage(_:)))) }',
  "stack.frame = NSRect(x:20,y:20,width:580,height:190)",
  "window.contentView!.addSubview(stack); window.center(); window.makeKeyAndOrderFront(nil)",
  "NSApp.activate(ignoringOtherApps:true)",
  "}",
  "@objc func runStage(_ button: NSButton) {",
  "guard child == nil else { return }",
  "let process = Process()",
  "process.executableURL = URL(fileURLWithPath:" +
    JSON.stringify(process.execPath) +
    ")",
  "process.arguments = [" +
    JSON.stringify(join(directory, "probe.ts")) +
    ",button.title]",
  "process.currentDirectoryURL = URL(fileURLWithPath:" +
    JSON.stringify(join(directory, "../../../..")) +
    ")",
  "process.terminationHandler = { [weak self] ended in",
  'DispatchQueue.main.async { self?.label.stringValue = "Finished (exit \\(ended.terminationStatus)); summaries are in dist/live-evidence."; self?.child = nil }',
  "}",
  'do { try process.run(); child = process; label.stringValue = "Running \\(button.title). Respond to the system prompt or adjust only this test app." }',
  'catch { label.stringValue = "Probe failed to launch."; return }',
  "DispatchQueue.main.asyncAfter(deadline:.now()+17) { if process.isRunning { process.terminate() } }",
  "DispatchQueue.main.asyncAfter(deadline:.now()+19) { if process.isRunning { kill(process.processIdentifier,SIGKILL) } }",
  "}",
  "func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {",
  "if let child, child.isRunning { child.terminate() }",
  "return .terminateNow",
  "}",
  "}",
  "let app = NSApplication.shared",
  "let delegate = Harness(); app.delegate = delegate; app.setActivationPolicy(.regular); app.run()",
].join("\n")
const sourcePath = join(directory, "dist/Launcher.swift")
await writeFile(sourcePath, source)
for (const args of [
  [
    "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc",
    "-sdk",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
    "-module-cache-path",
    join(directory, "dist/module-cache"),
    "-swift-version",
    "5",
    "-warnings-as-errors",
    sourcePath,
    "-o",
    executable,
  ],
  [
    "/usr/bin/codesign",
    "--force",
    "--sign",
    "-",
    "--identifier",
    identifier,
    join(contents, ".."),
  ],
  ["/usr/bin/codesign", "--verify", "--strict", join(contents, "..")],
]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exit !== 0)
      throw new Error(String(args[0]) + " failed: " + (stderr || stdout))
  } finally {
    clearTimeout(timer)
  }
}
console.log("Built unregistered test app: " + join(contents, ".."))
console.log("Permission scope: " + identifier)
