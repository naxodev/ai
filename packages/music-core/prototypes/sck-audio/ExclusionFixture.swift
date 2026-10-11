// Synthetic samples, public host-clock arithmetic, and fake stream actions only.
private func exclusionFixture(_ scenario: String) throws {
    func require(_ value: Bool) throws { if !value { throw HelperError(reason: "exclusion-fixture") } }
    func reject(_ body: () throws -> Void) throws {
        do { try body() } catch { return }
        throw HelperError(reason: "exclusion-fixture")
    }
    func tone(_ hz: Double, peak: Double = 0.1) -> [Float] {
        (0..<4800).map { Float(peak * sin(2 * Double.pi * hz * Double($0) / 48000)) }
    }
    if scenario == "application-policy" { try applicationPolicyFixture(); return }
    if scenario == "application-flow" { try applicationFlowFixture(); return }
    if scenario.hasPrefix("capture-") { try applicationCaptureFixture(scenario); return }
    if scenario == "denied" { throw NSError(domain: SCStreamErrorDomain, code: -3801) }
    if scenario == "exclusion-analysis" {
        let analyzer = ExclusionAnalyzer(); let samples = tone(2113)
        let value = try analyzer.analyze(samples, samples, index: 0)
        try require(abs(value.total - 0.005) < 1e-5 && abs(value.marker - 0.005) < 1e-5 && value.marker / value.spectralTotal > 0.999)
        let inverted = try analyzer.analyze(samples, samples.map { -$0 }, index: 0)
        try require(abs(inverted.marker - value.marker) < 1e-12) // Opposite channels must not cancel.
        let other = try analyzer.analyze(tone(997), tone(997), index: 0)
        try require(other.marker < 1e-8 && other.total > 0.0049)
        let silence = [Float](repeating: 0, count: 4800)
        let zero = try analyzer.analyze(silence, silence, index: 0)
        try require(zero.total == 0 && zero.marker == 0 && !zero.clipped)
        for invalid in [Float.nan, Float.infinity, -Float.infinity] {
            var corrupt = silence; corrupt[2000] = invalid
            try reject { _ = try analyzer.analyze(corrupt, silence, index: 0) }
            try reject { _ = try analyzer.analyze(silence, corrupt, index: 0) }
        }
        return
    }
    if scenario == "exclusion-coverage" {
        let coverage = ExclusionCoverage(); let samples = tone(2113)
        for index in 0..<80 { try coverage.append(at: Int64(index * 4800), left: samples, right: samples) }
        let windows = coverage.drain()
        try require(windows.count == 60 && windows.map { $0.index } == Array(0..<60) && coverage.drain().isEmpty)
        try reject { try ExclusionCoverage().append(at: 96001, left: samples, right: samples) }
        let gap = ExclusionCoverage()
        try gap.append(at: 96000, left: samples, right: samples)
        try reject { try gap.append(at: 100801, left: samples, right: samples) }
        try reject { try gap.append(at: 96000, left: samples, right: samples) }
        try reject { try ExclusionCoverage().append(at: 96000, left: [.infinity], right: [0]) }
        return
    }
    if scenario == "exclusion-controls" {
        let analyzer = ExclusionAnalyzer(); let samples = tone(2113)
        let reference = try analyzer.analyze(samples, samples, index: 0)
        func window(_ index: Int, total: Double, marker: Double, spectral: Double? = nil, clipped: Bool = false) -> ExclusionWindow {
            ExclusionWindow(index: index, total: total, marker: marker, spectralTotal: spectral ?? total, clipped: clipped)
        }
        for mode in ["pass", "leak", "unmarked", "missing", "contaminated", "clip"] {
            let measurements = ExclusionMeasurements()
            for index in 0..<60 {
                try measurements.record(target: window(index, total: mode == "unmarked" ? 0.001 : mode == "leak" ? reference.total : 0,
                    marker: mode == "leak" ? reference.marker : 0, clipped: mode == "clip"),
                    reference: window(index, total: mode == "missing" ? 0 : reference.total,
                        marker: mode == "missing" ? 0 : reference.marker,
                        spectral: mode == "missing" ? 0 : mode == "contaminated" ? reference.spectralTotal * 2 : reference.spectralTotal))
            }
            try require(measurements.windows == 60)
            try require(measurements.referenceWindows == ((mode == "missing" || mode == "contaminated") ? 0 : 60))
            try require(measurements.violations == ((mode == "leak" || mode == "unmarked") ? 60 : 0))
            try require(measurements.clippedWindows == (mode == "clip" ? 60 : 0))
        }
        let values = ExclusionMeasurements()
        try reject { try values.record(target: window(1, total: 0, marker: 0), reference: reference) }
        return
    }
    if scenario == "exclusion-clock" {
        let clock = CMClockGetHostTimeClock(); let current = CMClockGetTime(clock)
        let converted = try exclusionHostTime(current, clock: clock)
        try require(abs(CMTimeGetSeconds(CMTimeSubtract(current, converted))) < 1e-9)
        let anchor = CMTime(value: 100, timescale: 1)
        let sample = try exclusionSampleIndex(CMTime(value: 1001, timescale: 10), anchor: anchor)
        try require(sample == 4800)
        try reject { _ = try exclusionHostTime(.invalid, clock: clock) }
        try reject { _ = try exclusionSampleIndex(.indefinite, anchor: anchor) }
        return
    }
    if scenario == "exclusion-policy" {
        let location = ApplicationLocation.safari
        func profile(team: String = "", requirement: String = "identifier \"com.apple.Safari\" and anchor apple") -> ApplicationProfile {
            ApplicationProfile(revision: 1, bundleIdentifier: location.identifier, bundlePath: location.bundle,
                executablePath: location.executable, architecture: appArchitecture, teamIdentifier: team,
                cdHash: String(repeating: "a", count: 40), requirement: requirement)
        }
        try validateProfile(profile(), location: location)
        try reject { try validateProfile(profile(team: "ABCDEFGHIJ"), location: location) }
        try reject { try validateProfile(profile(requirement: "identifier \"com.apple.Safari\""), location: location) }
        try reject { try validateProfile(profile()) } // Safari's absent team cannot enter Kaset's policy.
        try validateSigningFields((location.identifier, "", String(repeating: "a", count: 40)), profile())
        try reject { try validateSigningFields((location.identifier, "ABCDEFGHIJ", String(repeating: "a", count: 40)), profile()) }
        return
    }
    if scenario == "exclusion-pcm" {
        for firstPlanar in [false, true] {
            let fence = ExclusionFormatFence()
            try fence.check(pcmFixture(false, planar: firstPlanar))
            try fence.check(pcmFixture(true, planar: firstPlanar))
            try reject { try fence.check(pcmFixture(false, planar: !firstPlanar)) }
        }
        // The shared decoder must retain the older sink's deliberate non-strict default.
        let legacy = SckAudioSink(Lease())
        legacy.consume(try pcmFixture(true, firstValue: .nan))
        try require(legacy.failure() == nil && legacy.samples.snapshot() != nil)
        return
    }
    if scenario == "exclusion-filter" {
        let identity = ApplicationIdentity(pid: 42, launch: "1:0", executable: "fixture")
        let app = DiscoveredApplication(pid: 42, bundleIdentifier: "com.apple.Safari")
        try exclusionFilter(identity, identifier: "com.apple.Safari", applications: [app], displays: [7], display: 7)
        for applications in [[], [app, app], [DiscoveredApplication(pid: 43, bundleIdentifier: "com.apple.Safari")],
                             [DiscoveredApplication(pid: 42, bundleIdentifier: kasetIdentifier)]] {
            try reject { try exclusionFilter(identity, identifier: "com.apple.Safari", applications: applications, displays: [7], display: 7) }
        }
        try reject { try exclusionFilter(identity, identifier: "com.apple.Safari", applications: [app], displays: [7, 8], display: 7) }
        return
    }
    if scenario == "exclusion-shutdown" {
        var events = [String]()
        func action(_ index: Int, denied: Bool = false, removeFails: Bool = false, cancelStop: Lease? = nil) -> ExclusionStreamActions {
            ExclusionStreamActions(register: { events.append("register\(index)") },
                start: { done in RunLoop.current.perform { events.append("start\(index)"); done(denied ? .failure(NSError(domain: SCStreamErrorDomain, code: -3801)) : .success(())) } },
                stop: { done in events.append("stop\(index)"); cancelStop?.stop("signal"); done(.success(())) },
                remove: { events.append("remove\(index)"); if removeFails { throw HelperError(reason: "cleanup-failed") } },
                didStop: { false }, terminal: { nil }, fence: { events.append("fence\(index)") })
        }
        let result = try withOwnedExclusionStreams([action(0), action(1)], lease: Lease(), verify: {}) { 7 }
        try require(result == 7 && events.suffix(6) == ["fence0", "fence1", "stop0", "stop1", "remove0", "remove1"])
        events.removeAll()
        do {
            _ = try withOwnedExclusionStreams([action(0, denied: true), action(1)], lease: Lease(), verify: {}) { 7 }
            throw HelperError(reason: "exclusion-fixture")
        } catch { try require(sckReason(error) == "permission" && events.contains("stop1") && !events.contains("stop0")) }
        events.removeAll()
        do {
            _ = try withOwnedExclusionStreams([action(0, denied: true, removeFails: true), action(1)], lease: Lease(), verify: {}) { 7 }
            throw HelperError(reason: "exclusion-fixture")
        } catch { try require(sckReason(error) == "cleanup-failed") }
        let cancelled = Lease()
        do {
            _ = try withOwnedExclusionStreams([action(0, cancelStop: cancelled), action(1)], lease: cancelled, verify: {}) { 7 }
            throw HelperError(reason: "exclusion-fixture")
        } catch { try require(sckReason(error) == "signal") }
        events.removeAll()
        var late: ((Result<Void, Error>) -> Void)?
        let lateAction = ExclusionStreamActions(register: { events.append("register1") }, start: { late = $0 },
            stop: { done in events.append("stop1"); done(.success(())) }, remove: { events.append("remove1") },
            didStop: { false }, terminal: { nil }, fence: {
                events.append("fence1")
                RunLoop.current.perform { events.append("late-start1"); late?(.success(())) }
            })
        do {
            _ = try withOwnedExclusionStreams([action(0, denied: true), lateAction], lease: Lease(), verify: {}) { 7 }
            throw HelperError(reason: "exclusion-fixture")
        } catch {
            try require(sckReason(error) == "permission")
            guard let fence = events.firstIndex(of: "fence1"), let start = events.firstIndex(of: "late-start1"),
                  let stop = events.firstIndex(of: "stop1") else { throw HelperError(reason: "exclusion-fixture") }
            try require(fence < start && start < stop)
        }
        events.removeAll()
        let failedRegistration = ExclusionStreamActions(register: { throw HelperError(reason: "setup") },
            start: { _ in events.append("unexpected-start1") }, stop: { _ in events.append("unexpected-stop1") },
            remove: { events.append("unexpected-remove1") }, didStop: { false }, terminal: { nil }, fence: {})
        do {
            _ = try withOwnedExclusionStreams([action(0), failedRegistration], lease: Lease(), verify: {}) { 7 }
            throw HelperError(reason: "exclusion-fixture")
        } catch { try require(sckReason(error) == "setup" && events == ["register0", "fence0", "remove0"]) }
        return
    }
    throw HelperError(reason: "arguments")
}
