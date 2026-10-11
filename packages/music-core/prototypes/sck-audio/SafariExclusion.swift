// Two application selections only. No process tap, global mix, screen output, or audio files.
private func loadSafariProfile() throws -> ApplicationProfile {
    let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: safariProfilePath))
    defer { try? handle.close() }
    return try decodeApplicationProfile(handle.read(upToCount: 16385) ?? Data(), digest: safariProfileDigest, location: .safari)
}
private func exclusionHostTime(_ timestamp: CMTime, clock: CMClock) throws -> CMTime {
    let value = CMSyncConvertTime(timestamp, from: clock, to: CMClockGetHostTimeClock())
    guard value.isNumeric, CMTimeGetSeconds(value).isFinite, CMTimeGetSeconds(value) > 0 else { throw HelperError(reason: "clock") }
    return value
}
private func exclusionSampleIndex(_ timestamp: CMTime, anchor: CMTime) throws -> Int64 {
    let relative = CMTimeSubtract(timestamp, anchor)
    guard relative.isNumeric, CMTimeGetSeconds(relative).isFinite,
          abs(CMTimeGetSeconds(relative)) < 60 else { throw HelperError(reason: "clock") }
    let sample = CMTimeConvertScale(relative, timescale: 48000, method: .roundHalfAwayFromZero)
    guard sample.isNumeric,
          abs(CMTimeGetSeconds(CMTimeSubtract(relative, sample))) <= 0.005 else { throw HelperError(reason: "clock") }
    return sample.value
}
private final class ExclusionFormatFence {
    private var first: CMFormatDescription?
    func check(_ buffer: CMSampleBuffer) throws {
        guard let current = CMSampleBufferGetFormatDescription(buffer) else { throw HelperError(reason: "format") }
        if let first {
            guard CMFormatDescriptionEqual(first, otherFormatDescription: current) else { throw HelperError(reason: "format") }
        } else { first = current }
    }
}
private final class ExclusionSink: NSObject, SCStreamOutput, SCStreamDelegate {
    private let lock = NSLock()
    private let lease: Lease
    private let coverage = ExclusionCoverage()
    private let format = ExclusionFormatFence()
    private var accepting = true
    private var terminal: Error?
    private var stopped = false
    private var clock: CMClock?
    private var anchor: CMTime?
    init(_ lease: Lease) { self.lease = lease }
    func configure(clock: CMClock, anchor: CMTime) { lock.lock(); defer { lock.unlock() }; self.clock = clock; self.anchor = anchor }
    func fence() { lock.lock(); defer { lock.unlock() }; accepting = false }
    func failure() -> Error? { lock.lock(); defer { lock.unlock() }; return terminal }
    func didStop() -> Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func drain() -> [ExclusionWindow] { lock.lock(); defer { lock.unlock() }; return coverage.drain() }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock(); if terminal == nil { terminal = error }; stopped = true; lock.unlock()
        lease.stop(sckReason(error))
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        lock.lock(); defer { lock.unlock() }
        guard accepting, terminal == nil, lease.state() == nil else { return }
        do {
            guard type == .audio else { throw HelperError(reason: "unexpected-output") }
            guard let clock, let anchor else { return } // Start warmup has no measurement authority.
            guard let currentClock = stream.synchronizationClock, currentClock === clock else { throw HelperError(reason: "clock") }
            try withSckPCM(buffer, strict: true) { list, count, timestamp in
                try format.check(buffer)
                let host = try exclusionHostTime(timestamp, clock: clock)
                let age = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), host))
                guard age.isFinite, age - Double(count) / 48000 >= -0.005, age <= 0.5 else { throw HelperError(reason: "clock") }
                let index = try exclusionSampleIndex(host, anchor: anchor)
                let buffers = UnsafeMutableAudioBufferListPointer(list)
                let first = buffers[0].mData!.assumingMemoryBound(to: Float.self)
                let second = buffers.count == 2 ? buffers[1].mData!.assumingMemoryBound(to: Float.self) : first
                var left = [Float](); var right = [Float](); left.reserveCapacity(count); right.reserveCapacity(count)
                for sample in 0..<count {
                    left.append(first[buffers.count == 1 ? sample * 2 : sample])
                    right.append(second[buffers.count == 1 ? sample * 2 + 1 : sample])
                }
                try coverage.append(at: index, left: left, right: right)
            }
        } catch {
            terminal = error
            lease.stop(sckReason(error))
        }
    }
}
private struct ExclusionStreamActions {
    let register: () throws -> Void
    let start: (@escaping (Result<Void, Error>) -> Void) -> Void
    let stop: (@escaping (Result<Void, Error>) -> Void) -> Void
    let remove: () throws -> Void
    let didStop: () -> Bool
    let terminal: () -> Error?
    let fence: () -> Void
}
private func withOwnedExclusionStreams<T>(_ actions: [ExclusionStreamActions], lease: Lease,
    verify: () throws -> Void, measure: () throws -> T) throws -> T {
    let completions = actions.map { _ in SckCompletion<Void>() }
    var registered = [Int](); var issued = [Int]()
    let outcome = Result<T, Error> {
        try verify()
        for (index, action) in actions.enumerated() { try action.register(); registered.append(index) }
        if let stopped = lease.state() { throw HelperError(reason: stopped.reason) }
        for (index, action) in actions.enumerated() {
            issued.append(index)
            action.start { completions[index].finish($0) }
        }
        for completion in completions {
            // This aggregate-only consumer owns startup, not a live feature stream.
            try sckWait(completion, lease: lease, onWait: { lease.wrote(at: nativeNow()) }).get()
        }
        try verify()
        return try measure()
    }
    for action in actions { action.fence() }
    var cleanupFailed = false
    let deadline = nativeNow() + 750
    for index in issued {
        do { try joinSckShutdown(completions[index], deadline: deadline, didStop: actions[index].didStop, stop: actions[index].stop) }
        catch { cleanupFailed = true }
    }
    for index in registered { do { try actions[index].remove() } catch { cleanupFailed = true } }
    let result = try captureSummaryAfterCleanup(outcome, cleanupFailed: cleanupFailed,
        terminal: actions.compactMap { $0.terminal() }.first)
    try verify()
    if let stopped = lease.state() { throw HelperError(reason: stopped.reason) }
    return result
}
private func exclusionFilter(_ identity: ApplicationIdentity, identifier: String, applications: [DiscoveredApplication], displays: [UInt32], display: UInt32) throws {
    guard applications.count == 1, applications.first?.pid == identity.pid,
          applications.first?.bundleIdentifier == identifier, displays == [display] else { throw HelperError(reason: "application-filter") }
}
private func captureSafariExclusion(_ source: Source, kaset: ApplicationIdentity, safari: ApplicationIdentity, lease: Lease) throws -> [String: Any] {
    let kasetProfile = try loadApplicationProfile(); let safariProfile = try loadSafariProfile()
    let verifyIdentities = { () throws -> Void in
        lease.wrote(at: nativeNow())
        guard try loadApplicationProfile() == kasetProfile, try loadSafariProfile() == safariProfile else { throw HelperError(reason: "application-profile") }
        _ = try verifiedApplication(kasetProfile, expected: kaset)
        _ = try verifiedApplication(safariProfile, expected: safari, location: .safari)
        try verifySingleWitness(source)
        lease.wrote(at: nativeNow())
    }
    try verifyIdentities()
    let content = try applicationShareableContent(lease, onWait: { lease.wrote(at: nativeNow()) })
    try verifyIdentities()
    let kasetApp = try singleApplication(content.applications.filter { $0.bundleIdentifier == kasetIdentifier })
    let safariApp = try singleApplication(content.applications.filter { $0.bundleIdentifier == ApplicationLocation.safari.identifier })
    guard kasetApp.processID == kaset.pid, safariApp.processID == safari.pid,
          content.applications.count <= 65536, content.displays.count <= 65536,
          let display = content.displays.sorted(by: { $0.displayID < $1.displayID }).first else { throw HelperError(reason: "source-loss") }
    let environment = try captureEnvironment(display.displayID)
    let verify = { () throws -> Void in
        try verifyIdentities()
        try verifyCaptureEnvironment(environment, captureEnvironment(environment.display))
    }
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true; configuration.captureMicrophone = false
    configuration.sampleRate = 48000; configuration.channelCount = 2; configuration.excludesCurrentProcessAudio = true
    configuration.width = 2; configuration.height = 2; configuration.queueDepth = 3
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1); configuration.showsCursor = false
    let applications = [kasetApp, safariApp]; let identities = [kaset, safari]
    let sinks = [ExclusionSink(lease), ExclusionSink(lease)]
    var streams = [SCStream]()
    for index in applications.indices {
        let filter = SCContentFilter(display: display, including: [applications[index]], exceptingWindows: [])
        try exclusionFilter(identities[index], identifier: applications[index].bundleIdentifier,
            applications: filter.includedApplications.map { DiscoveredApplication(pid: $0.processID, bundleIdentifier: $0.bundleIdentifier) },
            displays: filter.includedDisplays.map { $0.displayID }, display: environment.display)
        streams.append(SCStream(filter: filter, configuration: configuration, delegate: sinks[index]))
    }
    let actions = streams.indices.map { index -> ExclusionStreamActions in
        let stream = streams[index]; let sink = sinks[index]
        let queue = DispatchQueue(label: "dev.naxo.music.sck-safari-exclusion.\(index)")
        return ExclusionStreamActions(register: { try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: queue) },
            start: { done in stream.startCapture { error in done(error.map { .failure($0) } ?? .success(())) } },
            stop: { done in stream.stopCapture { error in done(error.map { .failure($0) } ?? .success(())) } },
            remove: { try stream.removeStreamOutput(sink, type: .audio) }, didStop: sink.didStop, terminal: sink.failure, fence: sink.fence)
    }
    return try withOwnedExclusionStreams(actions, lease: lease, verify: verify) {
        guard let targetClock = streams[0].synchronizationClock, let referenceClock = streams[1].synchronizationClock else { throw HelperError(reason: "clock") }
        let anchor = CMClockGetTime(CMClockGetHostTimeClock())
        sinks[0].configure(clock: targetClock, anchor: anchor); sinks[1].configure(clock: referenceClock, anchor: anchor)
        let endsAt = min(nativeNow() + 10000, captureHardDeadline - 1000)
        let measurements = ExclusionMeasurements()
        var pendingTarget = [ExclusionWindow](); var pendingReference = [ExclusionWindow]()
        while nativeNow() < endsAt && measurements.windows < 60 {
            if let stopped = lease.state() { throw HelperError(reason: stopped.reason) }
            for sink in sinks { if let failure = sink.failure() { throw failure } }
            guard streams[0].synchronizationClock === targetClock, streams[1].synchronizationClock === referenceClock else { throw HelperError(reason: "clock") }
            try verify()
            pendingTarget += sinks[0].drain(); pendingReference += sinks[1].drain()
            guard pendingTarget.count <= 60, pendingReference.count <= 60 else { throw HelperError(reason: "output-bound") }
            while !pendingTarget.isEmpty && !pendingReference.isEmpty {
                try measurements.record(target: pendingTarget.removeFirst(), reference: pendingReference.removeFirst())
            }
            // Warmup and valid silent PCM keep the lease alive without publishing features.
            lease.wrote(at: nativeNow())
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
        }
        try verify()
        return measurements.summary
    }
}
private func safariExclusionMain() throws {
    let args = Array(CommandLine.arguments.dropFirst())
    #if PROFILE_PREPARATION
    guard args == ["--prepare-safari-profile"] else { throw HelperError(reason: "arguments") }
    try prepareApplicationProfile(.safari)
    #else
    if args.count == 2, args[0] == "--self-test" { try exclusionFixture(args[1]); return }
    if args == ["--list-kaset-sources"] { _ = try loadApplicationProfile(); _ = try loadSafariProfile(); try listKasetSources(); return }
    let kasetCheck = args.first == "--check-kaset-application"
    let safariCheck = args.first == "--check-safari-reference"
    let capture = args.first == "--exclude-safari-audio"
    guard kasetCheck || safariCheck || capture, args.count == (kasetCheck ? 13 : safariCheck ? 19 : 25) else { throw HelperError(reason: "arguments") }
    let source = try applicationWitnessArguments(Array(args[1...12]))
    let kasetProfile = try loadApplicationProfile(); let safariProfile = try loadSafariProfile()
    try verifySingleWitness(source)
    let kaset = try verifiedApplication(kasetProfile, expected: kasetCheck ? nil : applicationIdentityArguments(Array(args[13...18])))
    if kasetCheck {
        FileHandle.standardOutput.write(try jsonLine(["event": "sck-application-preflight", "scope": "kaset-application",
            "identity": ["processIdentifier": kaset.pid, "launchIdentity": kaset.launch, "executableIdentity": kaset.executable]], limit: 4096))
        return
    }
    let safari = try verifiedApplication(safariProfile, expected: safariCheck ? nil : applicationIdentityArguments(Array(args[19...24])), location: .safari)
    if safariCheck {
        FileHandle.standardOutput.write(try jsonLine(["event": "sck-safari-preflight", "scope": "safari-application",
            "identity": ["processIdentifier": safari.pid, "launchIdentity": safari.launch, "executableIdentity": safari.executable]], limit: 4096))
        return
    }
    let lease = Lease(); lease.watch()
    let summary = try captureSafariExclusion(source, kaset: kaset, safari: safari, lease: lease)
    FileHandle.standardOutput.write(try jsonLine(summary, limit: 4096))
    #endif
}
let captureHardDeadline = nativeNow() + 15000
Thread.detachNewThread {
    while nativeNow() < captureHardDeadline { Thread.sleep(forTimeInterval: 0.005) }
    diagnostic("abnormal-deadline"); _exit(125)
}
do { try safariExclusionMain() }
catch { let reason = sckReason(error); diagnostic(reason); exit(reason == "cleanup-failed" ? 70 : reason == "permission" ? 77 : 1) }
