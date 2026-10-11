// THROWAWAY. Appended to the existing helper primitives by build.ts.
// No .screen/.microphone outputs, recording files, private TCC, or global fallback.
import ScreenCaptureKit
import CoreMedia

private func sckReason(_ error: Error) -> String {
    let value = error as NSError
    return value.domain == SCStreamErrorDomain && value.code == SCStreamError.Code.userDeclined.rawValue
        ? "permission" : (error as? HelperError)?.reason ?? "setup"
}
private final class SckCompletion<T> {
    private let lock = NSLock()
    private var result: Result<T, Error>?
    func finish(_ value: Result<T, Error>) { lock.lock(); defer { lock.unlock() }; if result == nil { result = value } }
    func read() -> Result<T, Error>? { lock.lock(); defer { lock.unlock() }; return result }
}
private func sckWait<T>(_ completion: SckCompletion<T>, lease: Lease? = nil, deadline: Double? = nil) throws -> Result<T, Error> {
    while completion.read() == nil {
        if let deadline, nativeNow() >= deadline { throw HelperError(reason: "cleanup-failed") }
        if let stopped = lease?.state() { throw HelperError(reason: stopped.reason) }
        _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
    }
    return completion.read()!
}
private func sckAwait<T>(_ lease: Lease, _ operation: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
    let completion = SckCompletion<T>()
    operation { completion.finish($0) }
    return try sckWait(completion, lease: lease).get()
}
private func joinSckShutdown(_ starting: SckCompletion<Void>, deadline: Double, didStop: () -> Bool,
                             stop: (@escaping (Result<Void, Error>) -> Void) -> Void) throws {
    // Joining Stop alone does not settle an older asynchronous Start. A late
    // successful Start must receive Stop after its own completion.
    let result = try sckWait(starting, deadline: deadline)
    if case .success = result, !didStop() {
        let stopping = SckCompletion<Void>()
        stop { stopping.finish($0) }
        try sckWait(stopping, deadline: deadline).get()
    }
}

private final class SckAudioSink: NSObject, SCStreamOutput, SCStreamDelegate {
    let samples = Samples()
    let lease: Lease
    private let lock = NSLock()
    private var terminal: Error?
    private var streamStopped = false
    private var accepting = true
    private let strictPCM: Bool
    init(_ lease: Lease, strictPCM: Bool = false) { self.lease = lease; self.strictPCM = strictPCM }
    func fence() { lock.lock(); accepting = false; lock.unlock() }
    private func acceptsSamples() -> Bool { lock.lock(); defer { lock.unlock() }; return accepting }
    func stopped(_ error: Error, streamDidStop: Bool = false) {
        lock.lock(); if terminal == nil { terminal = error }; streamStopped = streamStopped || streamDidStop; lock.unlock()
        lease.stop(sckReason(error))
    }
    func failure() -> Error? { lock.lock(); defer { lock.unlock() }; return terminal }
    func didStop() -> Bool { lock.lock(); defer { lock.unlock() }; return streamStopped }
    func stream(_ stream: SCStream, didStopWithError error: Error) { stopped(error, streamDidStop: true) }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { stopped(HelperError(reason: "unexpected-output")); return }
        consume(buffer)
    }
    func consume(_ buffer: CMSampleBuffer) {
        guard lease.state() == nil, acceptsSamples() else { return }
        guard CMSampleBufferIsValid(buffer), CMSampleBufferDataIsReady(buffer),
              let description = CMSampleBufferGetFormatDescription(buffer),
              let format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
              format.mFormatID == kAudioFormatLinearPCM, format.mSampleRate == 48000,
              format.mChannelsPerFrame == 2, format.mBitsPerChannel == 32,
              format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              format.mFormatFlags & kAudioFormatFlagIsPacked != 0,
              format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0 else {
            stopped(HelperError(reason: "format")); return
        }
        let count = CMSampleBufferGetNumSamples(buffer)
        let timestamp = CMSampleBufferGetPresentationTimeStamp(buffer)
        guard count > 0, count <= 16384, timestamp.isNumeric,
              CMTimeGetSeconds(timestamp).isFinite, CMTimeGetSeconds(timestamp) > 0 else {
            stopped(HelperError(reason: "clock")); return
        }
        let size = MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.size
        let storage = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { storage.deallocate() }
        storage.initializeMemory(as: UInt8.self, repeating: 0, count: size)
        let list = storage.bindMemory(to: AudioBufferList.self, capacity: 1)
        list.pointee.mNumberBuffers = 2
        var needed = 0
        var block: CMBlockBuffer?
        _ = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: &needed,
            bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard needed > 0, needed <= size else { stopped(HelperError(reason: "format")); return }
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: &needed,
            bufferListOut: list, bufferListSize: needed, blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, blockBufferOut: &block)
        guard status == noErr, needed <= size else { stopped(HelperError(reason: "format")); return }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        guard buffers.count == 1 || buffers.count == 2,
              buffers.allSatisfy({ $0.mData != nil && Int($0.mDataByteSize) == count * Int($0.mNumberChannels) * 4 }),
              (buffers.count == 1 && buffers[0].mNumberChannels == 2) ||
              (buffers.count == 2 && buffers.allSatisfy({ $0.mNumberChannels == 1 })) else {
            stopped(HelperError(reason: "format")); return
        }
        if strictPCM {
            for buffer in buffers {
                guard let data = buffer.mData else { stopped(HelperError(reason: "format")); return }
                let values = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self),
                    count: count * Int(buffer.mNumberChannels))
                guard values.allSatisfy({ $0.isFinite }) else { stopped(HelperError(reason: "format")); return }
            }
        }
        var time = AudioTimeStamp()
        time.mHostTime = CMClockConvertHostTimeToSystemUnits(timestamp)
        time.mFlags = .hostTimeValid
        withExtendedLifetime(block) { samples.append(list, time: &time, rate: 48000) }
    }
}

// Exact process match only. Application grouping and WebKit enumeration remain
// empirical gates; no fallback to a main app, bundle-wide group, or full display.
private enum SckSourceCheckpoint: String, CaseIterable {
    case beforeDiscoveryIdentity = "sck-before-discovery-identity"
    case beforeDiscoveryOwnership = "sck-before-discovery-ownership"
    case discovery = "sck-discovery"
    case applicationAbsent = "sck-application-absent"
    case applicationAmbiguous = "sck-application-ambiguous"
    case displayAbsent = "sck-display-absent"
    case afterDiscoveryIdentity = "sck-after-discovery-identity"
    case afterDiscoveryOwnership = "sck-after-discovery-ownership"
    case filterApplicationCount = "sck-filter-app-count"
    case filterApplicationPid = "sck-filter-app-pid"
    case filterDisplayCount = "sck-filter-display-count"
    case beforeStartIdentity = "sck-before-start-identity"
    case beforeStartOwnership = "sck-before-start-ownership"
    case runningIdentity = "sck-running-identity"
    case runningOwnership = "sck-running-ownership"
}
private func sckChecked<T>(_ checkpoint: SckSourceCheckpoint, report: (String) -> Void = diagnostic,
                           _ operation: () throws -> T) rethrows -> T {
    do { return try operation() }
    catch { report(checkpoint.rawValue); throw error }
}
private func sckSourceFailure(_ checkpoint: SckSourceCheckpoint, report: (String) -> Void = diagnostic) throws -> Never {
    report(checkpoint.rawValue)
    throw HelperError(reason: "source-loss")
}
private func selectSckSource<Application, Display>(_ pid: Int32, applications: [Application],
    processID: (Application) -> Int32, displays: [Display], report: (String) -> Void = diagnostic) throws -> (application: Application, display: Display) {
    let matches = applications.filter { processID($0) == pid }
    guard let app = matches.first else { try sckSourceFailure(.applicationAbsent, report: report) }
    guard matches.count == 1 else { try sckSourceFailure(.applicationAmbiguous, report: report) }
    guard let display = displays.first else { try sckSourceFailure(.displayAbsent, report: report) }
    return (app, display)
}
private func checkSckFilter(_ pid: Int32, applicationPids: [Int32], displayCount: Int,
                            report: (String) -> Void = diagnostic) throws {
    guard applicationPids.count == 1 else { try sckSourceFailure(.filterApplicationCount, report: report) }
    guard applicationPids.first == pid else { try sckSourceFailure(.filterApplicationPid, report: report) }
    guard displayCount == 1 else { try sckSourceFailure(.filterDisplayCount, report: report) }
}
private func withSckDiscovery<Content, Result>(verifyIdentity: () throws -> Void,
    verifyOwnership: () throws -> Void, discover: () throws -> Content,
    report: (String) -> Void = diagnostic, use: (Content) throws -> Result) throws -> Result {
    try sckChecked(.beforeDiscoveryIdentity, report: report, verifyIdentity)
    try sckChecked(.beforeDiscoveryOwnership, report: report, verifyOwnership)
    let content = try sckChecked(.discovery, report: report, discover)
    try sckChecked(.afterDiscoveryIdentity, report: report, verifyIdentity)
    try sckChecked(.afterDiscoveryOwnership, report: report, verifyOwnership)
    return try use(content)
}
private enum SckRequestMode { case capture, discovery }
private func performSckRequest(_ mode: SckRequestMode, discovery: () throws -> Void,
                               capture: () throws -> Void) throws {
    switch mode {
    case .discovery: try discovery()
    case .capture: try capture()
    }
}
private func inspectSck(_ source: Source, lease: Lease) throws {
    let summary = try withSckDiscovery(verifyIdentity: { try source.verify() },
        verifyOwnership: { try source.verifyAttribution() }, discover: { try shareableSckContent(lease) }) { content in
            ["event": "sck-source-discovery", "identityChecks": "passed-before-and-after",
             "attributionChecks": "passed-before-and-after",
             "matchingApplications": content.applications.filter { $0.processID == source.pid }.count,
             "displayCount": content.displays.count] as [String: Any]
        }
    guard lease.state() == nil else { throw HelperError(reason: "prototype-deadline") }
    FileHandle.standardOutput.write(try jsonLine(summary, limit: 4096))
}
private func shareableSckContent(_ lease: Lease) throws -> SCShareableContent {
    try sckAwait(lease) { done in
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { value, error in
            if let error { done(.failure(error)) }
            else if let value { done(.success(value)) }
            else { done(.failure(HelperError(reason: "source-loss"))) }
        }
    }
}
private func captureSck(_ source: Source, lease: Lease, cleanup: Cleanup) throws {
    let selected = try withSckDiscovery(verifyIdentity: { try source.verify() },
        verifyOwnership: { try source.verifyAttribution() }, discover: { try shareableSckContent(lease) }) { content in
            try selectSckSource(source.pid, applications: content.applications,
                processID: { $0.processID }, displays: content.displays)
        }
    let filter = SCContentFilter(display: selected.display, including: [selected.application], exceptingWindows: [])
    try checkSckFilter(source.pid, applicationPids: filter.includedApplications.map { $0.processID },
        displayCount: filter.includedDisplays.count)
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    configuration.captureMicrophone = false
    configuration.sampleRate = 48000
    configuration.channelCount = 2
    configuration.excludesCurrentProcessAudio = true
    configuration.width = 2; configuration.height = 2
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    configuration.queueDepth = 3
    configuration.showsCursor = false
    let sink = SckAudioSink(lease)
    let stream = SCStream(filter: filter, configuration: configuration, delegate: sink)
    let queue = DispatchQueue(label: "dev.naxo.music.sck-prototype.audio")
    try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: queue)
    let starting = SckCompletion<Void>()
    var startIssued = false
    defer {
        if startIssued {
            do {
                try joinSckShutdown(starting, deadline: nativeNow() + 650, didStop: sink.didStop) { done in
                    stream.stopCapture { error in done(error.map { .failure($0) } ?? .success(())) }
                }
            } catch { cleanup.failed = true }
        }
        do { try stream.removeStreamOutput(sink, type: .audio) } catch { cleanup.failed = true }
    }
    try sckChecked(.beforeStartIdentity) { try source.verify() }
    try sckChecked(.beforeStartOwnership) { try source.verifyAttribution() }
    guard lease.state() == nil else { return }
    startIssued = true
    stream.startCapture { error in
        starting.finish(error.map { .failure($0) } ?? .success(()))
    }
    try sckWait(starting, lease: lease).get()
    let analyzer = try Analyzer()
    let output = try Output(lease)
    var previous: UInt64 = 0
    var nextFrameAt = nativeNow()
    var nextIdentityAt = nativeNow()
    while lease.state() == nil {
        let now = nativeNow()
        if now >= nextIdentityAt {
            try sckChecked(.runningIdentity) { try source.verify() }
            try sckChecked(.runningOwnership) { try source.verifyAttribution() }
            nextIdentityAt = now + 100
        }
        try output.flush()
        if output.available, now >= nextFrameAt, let sample = sink.samples.snapshot(), sample.callbacks != previous,
           let features = try analyzer.features(sample, rate: 48000, lease: lease), lease.state() == nil {
            previous = sample.callbacks; nextFrameAt = now + 50
            try output.submit(features); try output.flush()
        }
        _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005))
    }
    if let failure = sink.failure() { throw failure }
}

private func pcmFixture(_ silent: Bool, rate: Double = 48000, planar: Bool = false, firstValue: Float? = nil, rightFirstValue: Float? = nil) throws -> CMSampleBuffer {
    let bytesPerFrame: UInt32 = planar ? 4 : 8
    var format = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | (planar ? kAudioFormatFlagIsNonInterleaved : 0),
        mBytesPerPacket: bytesPerFrame, mFramesPerPacket: 1, mBytesPerFrame: bytesPerFrame,
        mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
    var description: CMAudioFormatDescription?
    guard CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &format, layoutSize: 0,
        layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
        formatDescriptionOut: &description) == noErr, let description else { throw HelperError(reason: "pcm-fixture") }
    var left = (0..<sampleCount).map { silent ? Float(0) : Float(0.25 * sin(2 * Double.pi * 1000 * Double($0) / rate)) }
    if let firstValue { left[0] = firstValue }
    var right = [Float](repeating: 0, count: sampleCount)
    if let rightFirstValue { right[0] = rightFirstValue }
    let pcm: [Float] = planar ? left + right : zip(left, right).flatMap { [$0, $1] }
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
        blockLength: pcm.count * 4, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
        offsetToData: 0, dataLength: pcm.count * 4, flags: kCMBlockBufferAssureMemoryNowFlag,
        blockBufferOut: &block) == noErr, let block else { throw HelperError(reason: "pcm-fixture") }
    let copied = pcm.withUnsafeBytes { bytes in
        CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes.count)
    }
    guard copied == noErr else { throw HelperError(reason: "pcm-fixture") }
    let timestamp = CMClockMakeHostTimeFromSystemUnits(mach_absolute_time() - UInt64(50 / tickMs))
    var sample: CMSampleBuffer?
    guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault, dataBuffer: block,
        formatDescription: description, sampleCount: sampleCount, presentationTimeStamp: timestamp,
        packetDescriptions: nil, sampleBufferOut: &sample) == noErr,
        let sample else { throw HelperError(reason: "pcm-fixture") }
    return sample
}

private func syntheticSck(_ scenario: String) throws {
    if scenario == "discovery-flow" {
        var identities = 0
        var used = false
        var reported = [String]()
        do {
            _ = try withSckDiscovery(verifyIdentity: {
                identities += 1
                if identities == 2 { throw HelperError(reason: "source-loss") }
            }, verifyOwnership: {}, discover: { [Int32(7)] }, report: { reported.append($0) }) { applications in
                used = true
                return try selectSckSource(42, applications: applications, processID: { $0 }, displays: [1], report: { reported.append($0) })
            }
            throw HelperError(reason: "discovery-flow-fixture")
        } catch {
            guard identities == 2, !used, reported == [SckSourceCheckpoint.afterDiscoveryIdentity.rawValue],
                  sckReason(error) == "source-loss" else { throw HelperError(reason: "discovery-flow-fixture") }
        }
        var phases = [String]()
        let applications = try withSckDiscovery(verifyIdentity: { phases.append("identity") },
            verifyOwnership: { phases.append("ownership") }, discover: { phases.append("discovery"); return [Int32(7)] },
            report: { reported.append($0) }) { content in phases.append("use"); return content }
        guard phases == ["identity", "ownership", "discovery", "identity", "ownership", "use"],
              applications == [7] else { throw HelperError(reason: "discovery-flow-fixture") }
        var ownershipChecks = 0
        used = false; reported = []
        do {
            _ = try withSckDiscovery(verifyIdentity: {}, verifyOwnership: {
                ownershipChecks += 1
                if ownershipChecks == 2 { throw HelperError(reason: "source-loss") }
            }, discover: { 1 }, report: { reported.append($0) }) { value in used = true; return value }
            throw HelperError(reason: "discovery-flow-fixture")
        } catch {
            guard !used, reported == [SckSourceCheckpoint.afterDiscoveryOwnership.rawValue],
                  sckReason(error) == "source-loss" else { throw HelperError(reason: "discovery-flow-fixture") }
        }
        var captureCalls = 0
        var discoveryCalls = 0
        try performSckRequest(.discovery, discovery: { discoveryCalls += 1 }, capture: { captureCalls += 1 })
        guard discoveryCalls == 1, captureCalls == 0 else { throw HelperError(reason: "discovery-flow-fixture") }
        return
    }
    if scenario == "source-guards" {
        func expectFailure(_ expected: SckSourceCheckpoint, _ operation: ((String) -> Void) throws -> Void) throws {
            var reported = [String]()
            do {
                try operation { reported.append($0) }
                throw HelperError(reason: "source-guard-fixture")
            } catch {
                guard sckReason(error) == "source-loss", reported == [expected.rawValue] else {
                    throw HelperError(reason: "source-guard-fixture")
                }
            }
            diagnostic(expected.rawValue)
        }
        let checks: [SckSourceCheckpoint] = [.beforeDiscoveryIdentity, .beforeDiscoveryOwnership, .discovery,
            .afterDiscoveryIdentity, .afterDiscoveryOwnership, .beforeStartIdentity, .beforeStartOwnership,
            .runningIdentity, .runningOwnership]
        for checkpoint in checks {
            try expectFailure(checkpoint) { report in
                try sckChecked(checkpoint, report: report) { throw HelperError(reason: "source-loss") }
            }
        }
        for (pids, displays, expected) in [([Int32](), [1], SckSourceCheckpoint.applicationAbsent),
            ([7], [1], .applicationAbsent), ([42, 42], [1], .applicationAmbiguous), ([42], [], .displayAbsent)] {
            try expectFailure(expected) { report in
                _ = try selectSckSource(42, applications: pids, processID: { $0 }, displays: displays, report: report)
            }
        }
        for (pids, displays, expected) in [([Int32](), 1, SckSourceCheckpoint.filterApplicationCount),
            ([42, 7], 1, .filterApplicationCount), ([7], 1, .filterApplicationPid),
            ([42], 0, .filterDisplayCount), ([42], 2, .filterDisplayCount)] {
            try expectFailure(expected) { report in try checkSckFilter(42, applicationPids: pids, displayCount: displays, report: report) }
        }
        var reported = [String]()
        let selected = try selectSckSource(42, applications: [7, 42], processID: { $0 }, displays: [1, 2], report: { reported.append($0) })
        try checkSckFilter(42, applicationPids: [selected.application], displayCount: 1, report: { reported.append($0) })
        guard selected.application == 42, selected.display == 1, reported.isEmpty else { throw HelperError(reason: "source-guard-fixture") }
        do {
            try sckChecked(.discovery, report: { reported.append($0) }) { throw NSError(domain: SCStreamErrorDomain, code: -3801) }
            throw HelperError(reason: "source-guard-fixture")
        } catch {
            guard sckReason(error) == "permission", reported == [SckSourceCheckpoint.discovery.rawValue] else {
                throw HelperError(reason: "source-guard-fixture")
            }
        }
        return
    }
    if scenario == "shutdown" {
        let starting = SckCompletion<Void>()
        var events = [String]()
        RunLoop.current.perform { events.append("start"); starting.finish(.success(())) }
        try joinSckShutdown(starting, deadline: nativeNow() + 650, didStop: { false }) { done in
            events.append("stop"); done(.success(()))
        }
        guard events == ["start", "stop"] else { throw HelperError(reason: "shutdown-fixture") }
        let denied = SckCompletion<Void>()
        denied.finish(.failure(NSError(domain: SCStreamErrorDomain, code: -3801)))
        try joinSckShutdown(denied, deadline: nativeNow() + 650, didStop: { false }) { _ in events.append("unexpected-stop") }
        guard events == ["start", "stop"] else { throw HelperError(reason: "shutdown-fixture") }
        let pending = SckCompletion<Void>()
        do {
            try joinSckShutdown(pending, deadline: nativeNow() + 20, didStop: { false }) { _ in events.append("unexpected-stop") }
            throw HelperError(reason: "shutdown-fixture")
        } catch {
            guard sckReason(error) == "cleanup-failed" else { throw error }
        }
        return
    }
    if scenario == "pcm" {
        for (silent, planar) in [(false, false), (true, false), (false, true), (true, true)] {
            let lease = Lease()
            guard lease.heartbeat(parentMs: 1000, receivedAt: nativeNow()) else { throw HelperError(reason: "pcm-fixture") }
            let sink = SckAudioSink(lease)
            sink.consume(try pcmFixture(silent, planar: planar))
            if let failure = sink.failure() { throw failure }
            guard let sample = sink.samples.snapshot() else { throw HelperError(reason: "pcm-ring") }
            guard let features = try Analyzer().features(sample, rate: 48000, lease: lease) else { throw HelperError(reason: "pcm-features") }
            guard let channels = features["channels"] as? [String: Any], let rms = channels["rms"] as? [Float],
                  rms.count == 2, rms[1] == 0,
                  silent ? rms[0] == 0 : (rms[0] > 0.17 && rms[0] < 0.18) else { throw HelperError(reason: "pcm-level") }
        }
        let lease = Lease()
        let sink = SckAudioSink(lease)
        sink.consume(try pcmFixture(false, rate: 44100))
        guard sckReason(sink.failure() ?? HelperError(reason: "missing")) == "format",
              sink.samples.snapshot() == nil else { throw HelperError(reason: "pcm-fixture") }
        return
    }
    if scenario == "policy" {
        guard sckReason(NSError(domain: SCStreamErrorDomain, code: -3801)) == "permission",
              sckReason(NSError(domain: "other", code: -3801)) == "setup",
              sckReason(NSError(domain: SCStreamErrorDomain, code: -3818)) == "setup",
              sckReason(NSError(domain: SCStreamErrorDomain, code: -3821)) == "setup" else {
            throw HelperError(reason: "policy-fixture")
        }
        return
    }
    if scenario == "denied" { throw NSError(domain: SCStreamErrorDomain, code: -3801) }
    let lease = Lease(); lease.watch()
    let sink = SckAudioSink(lease)
    let output = try Output(lease)
    let analyzer = try Analyzer()
    let tone = (0..<sampleCount).map { Float(0.25 * sin(2 * Double.pi * 1000 * Double($0) / 48000)) }
    let zero = [Float](repeating: 0, count: sampleCount)
    var nextAt = nativeNow()
    var frames: UInt64 = 0
    while lease.state() == nil {
        try output.flush()
        if output.available, nativeNow() >= nextAt {
            let sample = Snapshot(left: scenario == "silence" ? zero : tone, right: zero,
                                  sampledAt: nativeNow() - 50, callbacks: frames)
            if let feature = try analyzer.features(sample, rate: 48000, lease: lease) {
                try output.submit(feature); try output.flush()
                frames += 1; nextAt = nativeNow() + 50
                if scenario == "revoked" || scenario == "generic-stop" {
                    sink.stopped(NSError(domain: SCStreamErrorDomain, code: scenario == "revoked" ? -3801 : -3821))
                }
            }
        }
        Thread.sleep(forTimeInterval: 0.005)
    }
    if let failure = sink.failure() { throw failure }
    reportLeaseStop(lease)
}

private func sckMain() throws {
    guard timebaseStatus == KERN_SUCCESS, tickMs.isFinite, tickMs > 0 else { throw HelperError(reason: "clock") }
    var args = Array(CommandLine.arguments.dropFirst())
    if args == ["--list-kaset-sources"] { try listKasetSources(); return }
    if args.count == 2, args.first == "--self-test", ["policy", "pcm", "shutdown", "source-guards", "discovery-flow", "denied", "revoked", "generic-stop", "silence", "stream"].contains(args[1]) {
        try syntheticSck(args[1]); return
    }
    let mode: SckRequestMode = args.first == "--discover-sck-source" ? .discovery : .capture
    if mode == .discovery { args.removeFirst() }
    guard args.count == 12, args[0] == "--protocol", args[1] == "1",
          args[2] == "--process-id", let pid = Int32(args[3]), pid > 0,
          args[4] == "--launch-identity", !args[5].isEmpty, args[5].utf8.count <= 512,
          args[6] == "--executable-identity", !args[7].isEmpty, args[7].utf8.count <= 512,
          args[8] == "--core-audio-object", let object = UInt32(args[9]), object > 0,
          args[10] == "--attribution", args[11] == "kaset-cache-v1" else { throw HelperError(reason: "arguments") }
    let lease = Lease(); lease.watch()
    let deadline = nativeNow() + (mode == .discovery ? 10000 : 15000)
    Thread.detachNewThread {
        while nativeNow() < deadline - 1000 { Thread.sleep(forTimeInterval: 0.01) }
        lease.stop("prototype-deadline")
        while nativeNow() < deadline { Thread.sleep(forTimeInterval: 0.005) }
        diagnostic("abnormal-deadline")
        _exit(125)
    }
    let cleanup = Cleanup()
    do {
        let source = Source(pid: pid, object: object, launch: args[5], executable: args[7], kasetAttribution: true)
        try performSckRequest(mode, discovery: { try inspectSck(source, lease: lease) },
            capture: { try captureSck(source, lease: lease, cleanup: cleanup) })
    } catch {
        if cleanup.failed { throw HelperError(reason: "cleanup-failed") }
        throw error
    }
    if cleanup.failed { throw HelperError(reason: "cleanup-failed") }
    reportLeaseStop(lease)
}
do { try sckMain() }
catch {
    let reason = sckReason(error)
    diagnostic(reason)
    exit(reason == "cleanup-failed" ? 70 : reason == "permission" ? 77 : 1)
}
