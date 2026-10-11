/** Build only. Does not launch/register the app or change privacy permissions. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildSckPrototype } from "./build.ts"
import { sourceTrace } from "./source-trace.ts"
import { sourceDiscovery } from "./source-discovery.ts"
import { applicationDiscovery } from "./application-discovery.ts"
import { buildApplicationDiscovery } from "./build-application.ts"
import { applicationCapture } from "./application-capture.ts"
import { buildApplicationCapture } from "./build-application-capture.ts"

const directory = import.meta.dir
const flags = process.argv.slice(2)
if (
  flags.length > 1 ||
  (flags.length === 1 &&
    flags[0] !== sourceTrace.buildFlag &&
    flags[0] !== sourceDiscovery.buildFlag &&
    flags[0] !== applicationDiscovery.buildFlag &&
    flags[0] !== applicationCapture.buildFlag)
)
  throw new Error(
    "Expected no flag, --source-trace, --source-discovery, --application-discovery, or --application-capture",
  )
const traceOnly = flags[0] === sourceTrace.buildFlag
const applicationOnly = flags[0] === applicationDiscovery.buildFlag
const captureOnly = flags[0] === applicationCapture.buildFlag
const discoveryOnly = flags[0] === sourceDiscovery.buildFlag || applicationOnly
const oneShot = traceOnly || discoveryOnly || captureOnly
const profile = captureOnly
  ? {
      appName: applicationCapture.appName,
      identifier: applicationCapture.bundleIdentifier,
      evidenceDirectory: applicationCapture.evidenceDirectory,
      entrypoint: "application-capture-probe.ts",
      stages: [applicationCapture.stage],
      sourceFile: "dist/ApplicationCaptureLauncher.swift",
      terminateAfter: 22,
      killAfter: 24,
      instructions:
        "Request Screen Access first. Play Kaset, then run one approved application-audio probe. Saves counts and levels only.",
      actionHint:
        "Play Kaset, then click capture. No operation starts until that click.",
    }
  : applicationOnly
    ? {
        appName: applicationDiscovery.appName,
        identifier: applicationDiscovery.bundleIdentifier,
        evidenceDirectory: applicationDiscovery.evidenceDirectory,
        entrypoint: "application-probe.ts",
        stages: [applicationDiscovery.stage],
        sourceFile: "dist/ApplicationDiscoveryLauncher.swift",
        terminateAfter: 10,
        killAfter: 12,
        instructions:
          "Request Screen Access first. Open the reviewed Kaset app, then run one approved application discovery. No stream is created.",
        actionHint:
          "Open the reviewed Kaset app, then click discover. No stream is created.",
      }
    : discoveryOnly
      ? {
          appName: sourceDiscovery.appName,
          identifier: sourceDiscovery.bundleIdentifier,
          evidenceDirectory: sourceDiscovery.evidenceDirectory,
          entrypoint: "discovery-probe.ts",
          stages: [sourceDiscovery.stage],
          sourceFile: "dist/DiscoveryLauncher.swift",
          terminateAfter: 10,
          killAfter: 12,
          instructions:
            "Request Screen Access first. Open Kaset, then run one approved discovery check. No audio or video capture.",
          actionHint:
            "Open Kaset, then click discover. No audio or video capture.",
        }
      : traceOnly
        ? {
            appName: sourceTrace.appName,
            identifier: sourceTrace.bundleIdentifier,
            evidenceDirectory: "dist/source-trace-evidence",
            entrypoint: "probe.ts",
            stages: [sourceTrace.stage],
            sourceFile: "dist/SourceTraceLauncher.swift",
            terminateAfter: 17,
            killAfter: 19,
            instructions:
              "Request Screen Access first. Play Kaset, then run one approved 15-second trace.",
            actionHint: "Play Kaset, then click trace. Capture is off.",
          }
        : {
            appName: "Kaset SCK Permission Probe",
            identifier: "dev.naxo.music.sck-matrix.20261011",
            evidenceDirectory: "dist/live-evidence",
            entrypoint: "probe.ts",
            stages: ["deny", "allow", "revoke"],
            sourceFile: "dist/Launcher.swift",
            terminateAfter: 17,
            killAfter: 19,
            instructions:
              "Each approved probe lasts at most 15 seconds. A stage button starts capture.",
            actionHint: "Capture is off.",
          }
const appName = profile.appName
const contents = join(directory, "dist", appName + ".app", "Contents")
const executable = join(contents, "MacOS/Launcher")
const identifier = profile.identifier
const evidenceDirectory = profile.evidenceDirectory
if (captureOnly) await buildApplicationCapture()
else if (applicationOnly) await buildApplicationDiscovery()
else await buildSckPrototype()
await mkdir(join(contents, "MacOS"), { recursive: true })
await writeFile(
  join(contents, "Info.plist"),
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>' +
    identifier +
    "</string><key>CFBundleExecutable</key><string>Launcher</string><key>CFBundleName</key><string>" +
    appName +
    "</string><key>CFBundlePackageType</key><string>APPL</string><key>NSAudioCaptureUsageDescription</key><string>" +
    (discoveryOnly
      ? "Inspect Kaset source metadata. This diagnostic creates no audio or video stream."
      : "Test bounded Kaset audio visualization after explicit approval.") +
    "</string></dict></plist>",
)
const source =
  (await readFile(join(directory, "HarnessActions.swift"), "utf8")) +
  "\n" +
  [
    "import Cocoa",
    "import CoreGraphics",
    "import Darwin",
    "final class Harness: NSObject, NSApplicationDelegate {",
    "var window: NSWindow!",
    "var child: Process?",
    "var used = false",
    "var traceButton: NSButton?",
    "private let actions = HarnessActions<Process>(requestScreen: { CGRequestScreenCaptureAccess() }, launch: { try $0.run() })",
    "let attemptPath = " +
      JSON.stringify(join(directory, evidenceDirectory, "attempt.json")),
    "let oneShot = " + String(oneShot),
    "let allowPreflightRetry = " + String(discoveryOnly || captureOnly),
    "let label = NSTextField(labelWithString: " +
      JSON.stringify(profile.instructions) +
      ")",
    "func applicationDidFinishLaunching(_ notification: Notification) {",
    "window = NSWindow(contentRect: NSRect(x:0,y:0,width:620,height:230),styleMask:[.titled,.closable,.miniaturizable],backing:.buffered,defer:false)",
    "window.title = " + JSON.stringify(appName),
    "let stack = NSStackView(); stack.orientation = .vertical; stack.spacing = 16",
    "label.maximumNumberOfLines = 3; label.preferredMaxLayoutWidth = 560; stack.addArrangedSubview(label)",
    'if oneShot { used = FileManager.default.fileExists(atPath: attemptPath); stack.addArrangedSubview(NSButton(title:"Request Screen Access",target:self,action:#selector(requestScreenAccess(_:)))) }',
    "for title in " +
      JSON.stringify(profile.stages) +
      " { let button = NSButton(title:title,target:self,action:#selector(runStage(_:))); if oneShot { traceButton = button; button.isEnabled = !used && CGPreflightScreenCaptureAccess() }; stack.addArrangedSubview(button) }",
    'if oneShot && used { label.stringValue = "This check was already attempted. No operation is running." }',
    "stack.frame = NSRect(x:20,y:20,width:580,height:190)",
    "window.contentView!.addSubview(stack); window.center(); window.makeKeyAndOrderFront(nil)",
    "NSApp.activate(ignoringOtherApps:true)",
    "}",
    "@objc func requestScreenAccess(_ button: NSButton) {",
    "guard let granted = actions.requestAccess(oneShot: oneShot, used: used, childRunning: child != nil) else { return }",
    "traceButton?.isEnabled = granted",
    "label.stringValue = granted ? " +
      JSON.stringify("Screen access is available. " + profile.actionHint) +
      ' : "Enable only this app in Screen & System Audio Recording, then quit and reopen. No operation is running."',
    "}",
    "@objc func runStage(_ button: NSButton) {",
    "guard child == nil, !oneShot || !used else { return }",
    'if oneShot && !CGPreflightScreenCaptureAccess() { label.stringValue = "Request Screen Access first. Capture is off."; return }',
    "let process = Process()",
    "process.executableURL = URL(fileURLWithPath:" +
      JSON.stringify(process.execPath) +
      ")",
    "process.arguments = [" +
      JSON.stringify(join(directory, profile.entrypoint)) +
      ",button.title]",
    "process.currentDirectoryURL = URL(fileURLWithPath:" +
      JSON.stringify(join(directory, "../../../..")) +
      ")",
    "process.terminationHandler = { [weak self] ended in",
    'DispatchQueue.main.async { self?.label.stringValue = "Finished (exit \\(ended.terminationStatus)); summaries are in ' +
      evidenceDirectory +
      '."; self?.child = nil; if let self, self.allowPreflightRetry && !FileManager.default.fileExists(atPath:self.attemptPath) { self.used = false; self.traceButton?.isEnabled = CGPreflightScreenCaptureAccess(); self.label.stringValue = "No protected operation was requested. Open Kaset and try again." } }',
    "}",
    'do { guard try actions.start(process, oneShot: oneShot, used: used, childRunning: child != nil) else { return }; child = process; if oneShot { used = true; button.isEnabled = false }; label.stringValue = "Running \\(button.title). Respond to the system prompt or adjust only this test app." }',
    'catch { label.stringValue = "Probe failed to launch."; return }',
    "DispatchQueue.main.asyncAfter(deadline:.now()+" +
      profile.terminateAfter +
      ") { if process.isRunning { process.terminate() } }",
    "DispatchQueue.main.asyncAfter(deadline:.now()+" +
      profile.killAfter +
      ") { if process.isRunning { kill(process.processIdentifier,SIGKILL) } }",
    "}",
    "func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {",
    "if let child, child.isRunning { child.terminate() }",
    "return .terminateNow",
    "}",
    "}",
    "let app = NSApplication.shared",
    "let delegate = Harness(); app.delegate = delegate; app.setActivationPolicy(.regular); app.run()",
  ].join("\n")
const sourcePath = join(directory, profile.sourceFile)
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
