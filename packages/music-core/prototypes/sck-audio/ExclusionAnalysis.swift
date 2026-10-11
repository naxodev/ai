// Fixed 100 ms analysis. PCM and per-window powers never leave this process.
private struct ExclusionWindow {
    let index: Int
    let total: Double
    let marker: Double
    let spectralTotal: Double
    let clipped: Bool
}
private final class ExclusionAnalyzer {
    static let frames = 4800
    private let weights = (0..<frames).map { 0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(frames)) }
    private let bases = (209...214).map { bin in (0..<frames).map { sample in
        let phase = 2 * Double.pi * Double(bin * sample) / Double(frames)
        return (cos(phase), sin(phase))
    } }
    func analyze(_ left: [Float], _ right: [Float], index: Int) throws -> ExclusionWindow {
        guard left.count == Self.frames, right.count == Self.frames else { throw HelperError(reason: "format") }
        var total = 0.0; var marker = 0.0; var spectralTotal = 0.0; var clipped = false
        let weightPower = weights.reduce(0) { $0 + $1 * $1 }
        for channel in [left, right] {
            for value in channel {
                guard value.isFinite else { throw HelperError(reason: "format") }
                total += Double(value) * Double(value)
                clipped = clipped || abs(value) >= 0.99
            }
            for basis in bases {
                var real = 0.0; var imaginary = 0.0
                for sample in 0..<Self.frames {
                    let value = Double(channel[sample]) * weights[sample]
                    real += value * basis[sample].0; imaginary += value * basis[sample].1
                }
                marker += (real * real + imaginary * imaginary) / (Double(Self.frames) * weightPower)
            }
            for sample in 0..<Self.frames {
                let weighted = Double(channel[sample]) * weights[sample]
                spectralTotal += weighted * weighted / (2 * weightPower)
            }
        }
        total /= Double(2 * Self.frames)
        guard total.isFinite, marker.isFinite else { throw HelperError(reason: "analysis") }
        return ExclusionWindow(index: index, total: total, marker: marker, spectralTotal: spectralTotal, clipped: clipped)
    }
}
private final class ExclusionCoverage {
    private let analyzer = ExclusionAnalyzer()
    private var nextInput: Int64?
    private var nextSample: Int64 = 96000
    private var left = [Float]()
    private var right = [Float]()
    private var pending = [ExclusionWindow]()
    private(set) var produced = 0
    init() { left.reserveCapacity(4800); right.reserveCapacity(4800) }
    func append(at index: Int64, left valuesLeft: [Float], right valuesRight: [Float]) throws {
        guard valuesLeft.count > 0, valuesLeft.count <= 16384, valuesRight.count == valuesLeft.count,
              valuesLeft.allSatisfy({ $0.isFinite }), valuesRight.allSatisfy({ $0.isFinite }),
              abs(index) < 48000 * 60 else { throw HelperError(reason: "format") }
        guard nextInput.map({ $0 == index }) ?? true else { throw HelperError(reason: "clock") }
        nextInput = index + Int64(valuesLeft.count)
        for offset in valuesLeft.indices {
            let sample = index + Int64(offset)
            if sample < 96000 || sample >= 384000 { continue }
            guard sample == nextSample else { throw HelperError(reason: "clock") }
            nextSample += 1
            left.append(valuesLeft[offset]); right.append(valuesRight[offset])
            if left.count == 4800 {
                guard produced < 60, pending.count < 60 else { throw HelperError(reason: "output-bound") }
                pending.append(try analyzer.analyze(left, right, index: produced))
                produced += 1; left.removeAll(keepingCapacity: true); right.removeAll(keepingCapacity: true)
            }
        }
    }
    func drain() -> [ExclusionWindow] { let result = pending; pending.removeAll(keepingCapacity: true); return result }
}
private final class ExclusionMeasurements {
    private(set) var windows = 0
    private(set) var referenceWindows = 0
    private(set) var violations = 0
    private(set) var clippedWindows = 0
    private(set) var targetTotalMax = 0.0
    private(set) var targetMarkerMax = 0.0
    private(set) var referenceTotalMax = 0.0
    private(set) var referenceMarkerMin = 1.0
    private(set) var referenceMarkerMax = 0.0
    func record(target: ExclusionWindow, reference: ExclusionWindow) throws {
        guard target.index == windows, reference.index == windows, windows < 60,
              [target.total, target.marker, target.spectralTotal, reference.total, reference.marker, reference.spectralTotal].allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }) else {
            throw HelperError(reason: "analysis")
        }
        windows += 1
        targetTotalMax = max(targetTotalMax, target.total); targetMarkerMax = max(targetMarkerMax, target.marker)
        referenceTotalMax = max(referenceTotalMax, reference.total); referenceMarkerMin = min(referenceMarkerMin, reference.marker)
        referenceMarkerMax = max(referenceMarkerMax, reference.marker)
        if target.clipped || reference.clipped { clippedWindows += 1 }
        let control = !reference.clipped && reference.marker >= 1e-4 && reference.spectralTotal > 0 && reference.marker / reference.spectralTotal >= 0.95
        if control { referenceWindows += 1 }
        if control && !target.clipped && (target.marker > max(1e-8, 1e-4 * reference.marker) || target.total > max(1e-10, 1e-4 * reference.total)) {
            violations += 1
        }
    }
    var summary: [String: Any] {
        ["event": "sck-safari-exclusion", "scope": "kaset-paused-safari-marker", "verification": "passed-throughout",
         "streamsStarted": 2, "cleanup": "joined", "windows": windows, "referenceWindows": referenceWindows,
         "violations": violations, "clippedWindows": clippedWindows, "targetTotalMax": targetTotalMax,
         "targetMarkerMax": targetMarkerMax, "referenceTotalMax": referenceTotalMax,
         "referenceMarkerMin": windows > 0 ? referenceMarkerMin : 0, "referenceMarkerMax": referenceMarkerMax, "isolationEstablished": false]
    }
}
