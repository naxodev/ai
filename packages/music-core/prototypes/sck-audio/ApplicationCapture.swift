// Isolated application feasibility. One included app; no screen/microphone output or audio files.
import ColorSync
private final class CaptureMeasurements {
    private(set) var frames = 0
    private(set) var signalFrames = 0
    private(set) var peakRms: Double = 0
    private var firstAt: Double?
    private var lastAt: Double?
    private var previousCallback: UInt64?
    var sampleSpanMs: Double { max(0, (lastAt ?? 0) - (firstAt ?? 0)) }

    @discardableResult func record(rms: [Float], sampleAt: Double, ageMs: Double, callback: UInt64) throws -> Bool {
        guard rms.count == 2, rms.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }), sampleAt.isFinite else { throw HelperError(reason: "format") }
        guard ageMs.isFinite, ageMs >= 0, ageMs <= 500,
              previousCallback.map({ callback > $0 }) ?? true,
              lastAt.map({ sampleAt > $0 }) ?? true else { return false }
        guard frames < 300 else { throw HelperError(reason: "output-bound") }
        let level = Double(max(rms[0], rms[1]))
        frames += 1
        if level >= 0.0001 { signalFrames += 1 }
        peakRms = max(peakRms, level)
        if firstAt == nil { firstAt = sampleAt }
        lastAt = sampleAt; previousCallback = callback
        return true
    }
    var summary: [String: Any] {
        ["event": "sck-application-feasibility", "scope": "kaset-application", "verification": "passed-throughout",
         "streamStarted": true, "cleanup": "joined", "matchingApplications": 1,
         "frames": frames, "signalFrames": signalFrames, "peakRms": peakRms, "sampleSpanMs": sampleSpanMs,
         "isolationEstablished": false]
    }
}
private func verifyApplicationFilter(_ identity: ApplicationIdentity, applications: [DiscoveredApplication],
    displays: [UInt32], expectedDisplay: UInt32) throws {
    guard applications.count == 1, applications.first?.pid == identity.pid,
          applications.first?.bundleIdentifier == kasetIdentifier, displays == [expectedDisplay] else {
        try appFailure("application-filter")
    }
}
private struct CaptureEnvironment: Equatable {
    let display: UInt32
    let displayUid: String
    let width: Int
    let height: Int
    let output: AudioObjectID
    let outputUid: String
}
private func captureEnvironment(_ display: UInt32) throws -> CaptureEnvironment {
    guard CGDisplayIsActive(display) != 0 else { try appFailure("application-route") }
    let output = try number(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice)
    guard output != kAudioObjectUnknown else { try appFailure("application-route") }
    let outputUid = try string(output, kAudioDevicePropertyDeviceUID)
    guard !outputUid.isEmpty, outputUid.utf8.count <= 512,
          let displayUuid = CGDisplayCreateUUIDFromDisplayID(display)?.takeRetainedValue(),
          let displayUid = CFUUIDCreateString(nil, displayUuid) else { try appFailure("application-route") }
    return CaptureEnvironment(display: display, displayUid: displayUid as String,
        width: CGDisplayPixelsWide(display), height: CGDisplayPixelsHigh(display), output: output, outputUid: outputUid)
}
private func verifyCaptureEnvironment(_ expected: CaptureEnvironment, _ current: CaptureEnvironment) throws {
    guard current == expected else { try appFailure("application-route") }
}
private func captureSummaryAfterCleanup<T>(_ outcome: Result<T, Error>, cleanupFailed: Bool, terminal: Error?) throws -> T {
    if cleanupFailed { throw HelperError(reason: "cleanup-failed") }
    if let terminal { throw terminal }
    return try outcome.get()
}
private func withOwnedApplicationStream<T>(lease: Lease, prepare: () throws -> Void,
    start: (@escaping (Result<Void, Error>) -> Void) -> Void,
    stop: (@escaping (Result<Void, Error>) -> Void) -> Void,
    remove: () throws -> Void, didStop: () -> Bool, terminal: () -> Error?, fence: () -> Void = {},
    measure: () throws -> T) throws -> T {
    let starting = SckCompletion<Void>()
    var issued = false
    let outcome: Result<T, Error> = Result {
        try prepare()
        if let stopped = lease.state() { throw HelperError(reason: stopped.reason) }
        issued = true
        start { starting.finish($0) }
        try sckWait(starting, lease: lease).get()
        return try measure()
    }
    // Fence queued audio before joining a late Start, Stop, and output removal.
    fence()
    var cleanupFailed = false
    if issued {
        do { try joinSckShutdown(starting, deadline: nativeNow() + 750, didStop: didStop, stop: stop) }
        catch { cleanupFailed = true }
    }
    do { try remove() } catch { cleanupFailed = true }
    let result = try captureSummaryAfterCleanup(outcome, cleanupFailed: cleanupFailed, terminal: terminal())
    if let stopped = lease.state() { throw HelperError(reason: stopped.reason) }
    return result
}
private func captureApplication(_ source: Source, expected: ApplicationIdentity, lease: Lease) throws -> [String: Any] {
    let profile = try loadApplicationProfile()
    let verifyApp = { () throws -> Void in
        guard try loadApplicationProfile() == profile else { throw HelperError(reason: "application-profile") }
        _ = try verifiedApplication(profile, expected: expected)
    }
    let selected = try withApplicationDiscovery(verifyApplication: verifyApp,
        verifyWitness: { try verifySingleWitness(source) }, discover: { try applicationShareableContent(lease) }) { content in
        let applications = content.applications.map { DiscoveredApplication(pid: $0.processID, bundleIdentifier: $0.bundleIdentifier) }
        try checkApplicationMatch(expected, applications: applications, displayCount: content.displays.count)
        let app = try singleApplication(content.applications.filter { $0.bundleIdentifier == kasetIdentifier && $0.processID == expected.pid })
        guard let display = content.displays.sorted(by: { $0.displayID < $1.displayID }).first else { try appFailure("application-display") }
        return (application: app, display: display)
    }
    let environment = try captureEnvironment(selected.display.displayID)
    let filter = SCContentFilter(display: selected.display, including: [selected.application], exceptingWindows: [])
    try verifyApplicationFilter(expected,
        applications: filter.includedApplications.map { DiscoveredApplication(pid: $0.processID, bundleIdentifier: $0.bundleIdentifier) },
        displays: filter.includedDisplays.map { $0.displayID }, expectedDisplay: environment.display)
    let verify = { () throws -> Void in
        try appChecked("application-running-identity", verifyApp)
        try appChecked("application-running-witness") { try verifySingleWitness(source) }
        try verifyCaptureEnvironment(environment, captureEnvironment(environment.display))
    }
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true; configuration.captureMicrophone = false
    configuration.sampleRate = 48000; configuration.channelCount = 2
    configuration.excludesCurrentProcessAudio = true
    configuration.width = 2; configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    configuration.queueDepth = 3; configuration.showsCursor = false
    let sink = SckAudioSink(lease, strictPCM: true)
    let stream = SCStream(filter: filter, configuration: configuration, delegate: sink)
    let queue = DispatchQueue(label: "dev.naxo.music.sck-application-capture.audio")
    try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: queue)
    let measurements = CaptureMeasurements()
    let summary = try withOwnedApplicationStream(lease: lease,
        prepare: { try appChecked("application-before-start", verify) },
        start: { done in stream.startCapture { error in done(error.map { .failure($0) } ?? .success(())) } },
        stop: { done in stream.stopCapture { error in done(error.map { .failure($0) } ?? .success(())) } },
        remove: { try stream.removeStreamOutput(sink, type: .audio) }, didStop: sink.didStop, terminal: sink.failure, fence: sink.fence) {
        let analyzer = try Analyzer()
        let endsAt = min(nativeNow() + 10000, captureHardDeadline - 1000)
        var nextFrameAt = nativeNow()
        while nativeNow() < endsAt {
            if let failure = sink.failure() { throw failure }
            if let stopped = lease.state() { throw HelperError(reason: stopped.reason) }
            let now = nativeNow()
            if now >= nextFrameAt {
                // Every accepted feature follows fresh application, witness, and route checks.
                try verify()
                if let sample = sink.samples.snapshot(),
                   let features = try analyzer.features(sample, rate: 48000, lease: lease),
                   let channels = features["channels"] as? [String: Any], let rms = channels["rms"] as? [Float],
                   lease.state() == nil, nativeNow() < endsAt,
                   try measurements.record(rms: rms, sampleAt: sample.sampledAt, ageMs: nativeNow() - sample.sampledAt, callback: sample.callbacks) {
                    // The in-memory aggregate is the output consumer. No feature arrays leave this process.
                    lease.wrote(at: nativeNow())
                }
                nextFrameAt = nativeNow() + 50
            }
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005))
        }
        try verify()
        return measurements.summary
    }
    // No summary can leave after a proof or route change during teardown.
    try verify()
    if let stopped = lease.state() { throw HelperError(reason: stopped.reason) }
    if let failure = sink.failure() { throw failure }
    return summary
}
private func applicationCaptureFixture(_ scenario: String) throws {
    func reject(_ operation: () throws -> Void) throws {
        do { try operation() } catch { return }
        throw HelperError(reason: "capture-fixture")
    }
    if scenario == "capture-measurements" {
        let values = CaptureMeasurements()
        try values.record(rms: [0, 0], sampleAt: 1000, ageMs: 50, callback: 1)
        try values.record(rms: [0.2, 0], sampleAt: 1250, ageMs: 50, callback: 2)
        try values.record(rms: [0.1, 0], sampleAt: 1500, ageMs: 50, callback: 3)
        guard values.frames == 3, values.signalFrames == 2, values.peakRms == Double(Float(0.2)), values.sampleSpanMs == 500 else { throw HelperError(reason: "capture-fixture") }
        guard try !values.record(rms: [1, 1], sampleAt: 2000, ageMs: 501, callback: 4),
              try !values.record(rms: [1, 1], sampleAt: 2000, ageMs: -1, callback: 4),
              try !values.record(rms: [1, 1], sampleAt: 2000, ageMs: 50, callback: 3), values.frames == 3 else { throw HelperError(reason: "capture-fixture") }
        try reject { _ = try values.record(rms: [.nan, 0], sampleAt: 2000, ageMs: 50, callback: 4) }
        try reject { _ = try values.record(rms: [2, 0], sampleAt: 2000, ageMs: 50, callback: 4) }
        let boundary = Float(0.0001)
        let thresholdValues = CaptureMeasurements()
        try thresholdValues.record(rms: [boundary, 0], sampleAt: 1000, ageMs: 50, callback: 1)
        guard thresholdValues.signalFrames == 0, thresholdValues.peakRms < 0.0001 else { throw HelperError(reason: "capture-fixture") }
        try thresholdValues.record(rms: [boundary.nextUp, 0], sampleAt: 1600, ageMs: 50, callback: 2)
        guard thresholdValues.signalFrames == 1, thresholdValues.peakRms >= 0.0001 else { throw HelperError(reason: "capture-fixture") }
        return
    }
    if scenario == "capture-filter" {
        let identity = ApplicationIdentity(pid: 42, launch: "100:0", executable: "fixture")
        let app = DiscoveredApplication(pid: 42, bundleIdentifier: kasetIdentifier)
        try verifyApplicationFilter(identity, applications: [app], displays: [7], expectedDisplay: 7)
        for applications in [[DiscoveredApplication](), [app, app], [DiscoveredApplication(pid: 43, bundleIdentifier: kasetIdentifier)],
                             [DiscoveredApplication(pid: 42, bundleIdentifier: "other.app")]] {
            try reject { try verifyApplicationFilter(identity, applications: applications, displays: [7], expectedDisplay: 7) }
        }
        for displays in [[UInt32](), [7, 8], [8]] { try reject { try verifyApplicationFilter(identity, applications: [app], displays: displays, expectedDisplay: 7) } }
        return
    }
    if scenario == "capture-environment" {
        let expected = CaptureEnvironment(display: 7, displayUid: "display-a", width: 1920, height: 1080, output: 42, outputUid: "device-a")
        try verifyCaptureEnvironment(expected, expected)
        for current in [
            CaptureEnvironment(display: 7, displayUid: "display-b", width: 1920, height: 1080, output: 42, outputUid: "device-a"),
            CaptureEnvironment(display: 7, displayUid: "display-a", width: 1920, height: 1080, output: 42, outputUid: "device-b"),
            CaptureEnvironment(display: 7, displayUid: "display-a", width: 1920, height: 1080, output: 43, outputUid: "device-a"),
            CaptureEnvironment(display: 7, displayUid: "display-a", width: 1280, height: 720, output: 42, outputUid: "device-a")
        ] { try reject { try verifyCaptureEnvironment(expected, current) } }
        return
    }
    if scenario == "capture-shutdown" {
        var events = [String]()
        let lease = Lease()
        lease.stop("cancelled")
        // A cancelled admission never starts, but still removes its registered output.
        do {
            _ = try withOwnedApplicationStream(lease: lease, prepare: {}, start: { _ in events.append("unexpected-start") },
                stop: { _ in events.append("unexpected-stop") }, remove: { events.append("remove") }, didStop: { false }, terminal: { nil }) { 7 }
            throw HelperError(reason: "capture-fixture")
        } catch { guard events == ["remove"], sckReason(error) == "cancelled" else { throw HelperError(reason: "capture-fixture") } }
        events.removeAll()
        let runningLease = Lease()
        let result = try withOwnedApplicationStream(lease: runningLease, prepare: { events.append("verify") },
            start: { done in RunLoop.current.perform { events.append("start"); done(.success(())) } },
            stop: { done in events.append("stop"); done(.success(())) }, remove: { events.append("remove") },
            didStop: { false }, terminal: { nil }, fence: { events.append("fence") }) { events.append("measure"); return 7 }
        guard result == 7, events == ["verify", "start", "measure", "fence", "stop", "remove"] else { throw HelperError(reason: "capture-fixture") }
        events.removeAll()
        let cancelledLease = Lease()
        do {
            _ = try withOwnedApplicationStream(lease: cancelledLease, prepare: {}, start: { done in
                cancelledLease.stop("cancelled")
                RunLoop.current.perform { events.append("late-start"); done(.success(())) }
            }, stop: { done in events.append("stop"); done(.success(())) }, remove: { events.append("remove") },
               didStop: { false }, terminal: { nil }) { events.append("unexpected-measure"); return 7 }
            throw HelperError(reason: "capture-fixture")
        } catch {
            guard sckReason(error) == "cancelled", events == ["late-start", "stop", "remove"] else { throw HelperError(reason: "capture-fixture") }
        }
        events.removeAll()
        do {
            _ = try withOwnedApplicationStream(lease: Lease(), prepare: {},
                start: { $0(.failure(NSError(domain: SCStreamErrorDomain, code: -3801))) },
                stop: { _ in events.append("unexpected-stop") }, remove: { events.append("remove"); throw HelperError(reason: "output-failed") },
                didStop: { false }, terminal: { nil }) { 7 }
            throw HelperError(reason: "capture-fixture")
        } catch {
            guard sckReason(error) == "cleanup-failed", events == ["remove"] else { throw HelperError(reason: "capture-fixture") }
        }
        do {
            _ = try captureSummaryAfterCleanup(Result<Int, Error>.failure(NSError(domain: SCStreamErrorDomain, code: -3801)), cleanupFailed: true, terminal: nil)
            throw HelperError(reason: "capture-fixture")
        } catch { guard sckReason(error) == "cleanup-failed" else { throw error } }
        events.removeAll()
        let teardownLease = Lease()
        do {
            _ = try withOwnedApplicationStream(lease: teardownLease, prepare: {}, start: { $0(.success(())) },
                stop: { done in teardownLease.stop("cancelled"); events.append("stop"); done(.success(())) },
                remove: { events.append("remove") }, didStop: { false }, terminal: { nil }) { 7 }
            throw HelperError(reason: "capture-fixture")
        } catch {
            guard sckReason(error) == "cancelled", events == ["stop", "remove"] else { throw HelperError(reason: "capture-fixture") }
        }
        return
    }
    if scenario == "capture-pcm" {
        for (silent, planar) in [(false, false), (true, false), (false, true), (true, true)] {
            let lease = Lease()
            guard lease.heartbeat(parentMs: 1000, receivedAt: nativeNow()) else { throw HelperError(reason: "capture-fixture") }
            let sink = SckAudioSink(lease, strictPCM: true); sink.consume(try pcmFixture(silent, planar: planar))
            if let failure = sink.failure() { throw failure }
            guard let sample = sink.samples.snapshot(), let features = try Analyzer().features(sample, rate: 48000, lease: lease),
                  let channels = features["channels"] as? [String: Any], let rms = channels["rms"] as? [Float] else { throw HelperError(reason: "capture-fixture") }
            let measurements = CaptureMeasurements()
            try measurements.record(rms: rms, sampleAt: sample.sampledAt, ageMs: 50, callback: sample.callbacks)
            guard measurements.frames == 1, silent ? measurements.peakRms == 0 : (measurements.peakRms > 0.17 && measurements.peakRms < 0.18) else {
                throw HelperError(reason: "capture-fixture")
            }
        }
        for invalid in [Float.nan, Float.infinity, -Float.infinity] {
            for planar in [false, true] {
                for channel in [0, 1] {
                    let sink = SckAudioSink(Lease(), strictPCM: true)
                    sink.consume(try pcmFixture(true, planar: planar, firstValue: channel == 0 ? invalid : nil,
                        rightFirstValue: channel == 1 ? invalid : nil))
                    guard sckReason(sink.failure() ?? HelperError(reason: "missing")) == "format", sink.samples.snapshot() == nil else {
                        throw HelperError(reason: "capture-fixture")
                    }
                }
            }
        }
        let fenced = SckAudioSink(Lease(), strictPCM: true)
        fenced.fence()
        fenced.consume(try pcmFixture(false))
        guard fenced.failure() == nil, fenced.samples.snapshot() == nil else { throw HelperError(reason: "capture-fixture") }
        return
    }
    throw HelperError(reason: "arguments")
}
private func applicationCaptureMain() throws {
    guard timebaseStatus == KERN_SUCCESS, tickMs.isFinite, tickMs > 0 else { throw HelperError(reason: "clock") }
    let args = Array(CommandLine.arguments.dropFirst())
    if args.count == 2, args.first == "--self-test" {
        if args[1] == "application-policy" { try applicationPolicyFixture(); return }
        if args[1] == "application-flow" { try applicationFlowFixture(); return }
        if args[1] == "denied" { throw NSError(domain: SCStreamErrorDomain, code: -3801) }
        try applicationCaptureFixture(args[1]); return
    }
    if args == ["--list-kaset-sources"] { _ = try loadApplicationProfile(); try listKasetSources(); return }
    let preflight = args.first == "--check-kaset-application"
    guard preflight || args.first == "--capture-kaset-application", args.count == (preflight ? 13 : 19) else { throw HelperError(reason: "arguments") }
    let source = try applicationWitnessArguments(Array(args[1...12]))
    if preflight {
        let profile = try loadApplicationProfile()
        try verifySingleWitness(source)
        let application = try verifiedApplication(profile)
        FileHandle.standardOutput.write(try jsonLine(["event": "sck-application-preflight", "scope": "kaset-application",
            "identity": ["processIdentifier": application.pid, "launchIdentity": application.launch, "executableIdentity": application.executable]], limit: 4096))
        return
    }
    let lease = Lease(); lease.watch()
    let summary = try captureApplication(source, expected: applicationIdentityArguments(Array(args[13...18])), lease: lease)
    FileHandle.standardOutput.write(try jsonLine(summary, limit: 4096))
}
let captureHardDeadline = nativeNow() + 15000
Thread.detachNewThread {
    while nativeNow() < captureHardDeadline { Thread.sleep(forTimeInterval: 0.005) }
    diagnostic("abnormal-deadline"); _exit(125)
}
do { try applicationCaptureMain() }
catch {
    let reason = sckReason(error)
    diagnostic(reason)
    exit(reason == "cleanup-failed" ? 70 : reason == "permission" ? 77 : 1)
}
