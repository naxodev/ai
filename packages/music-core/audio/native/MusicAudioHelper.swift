// LOCAL-ONLY candidate. The daemon does not enable this helper yet.
// Capture includes one approved process object. No microphone, routing, or files.
import Foundation
import CoreFoundation
import Security
import CoreAudio
import AudioToolbox
import Accelerate
import Darwin

private var signalStop: sig_atomic_t = 0
signal(SIGINT) { _ in signalStop = 1 }
signal(SIGTERM) { _ in signalStop = 1 }
signal(SIGPIPE, SIG_IGN)

private var timebase = mach_timebase_info_data_t()
private let timebaseStatus = mach_timebase_info(&timebase)
private let tickMs = Double(timebase.numer) / Double(timebase.denom) / 1_000_000
private func nativeNow() -> Double { Double(mach_continuous_time()) * tickMs }
private let frameLimit = 16 * 1024
private let sampleCount = 2048

private struct HelperError: Error {
    let reason: String
}
private func check(_ status: OSStatus) throws {
    if status != noErr { throw HelperError(reason: "setup") }
}
private func diagnostic(_ reason: String) {
    // Reasons are fixed lifecycle names, never external messages or audio data.
    let bytes = Array("{\"event\":\"music-audio-helper-stop\",\"reason\":\"\(reason)\"}\n".utf8)
    bytes.withUnsafeBytes { buffer in
        if let base = buffer.baseAddress { _ = Darwin.write(STDERR_FILENO, base, buffer.count) }
    }
}
private func jsonLine(_ value: [String: Any], limit: Int = frameLimit) throws -> Data {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard data.count + 1 <= limit else { throw HelperError(reason: "output-bound") }
    return data + Data([10])
}

// Each heartbeat carries the parent's capture-monotonic timestamp at send time.
// Mapping at receipt subtracts delivery delay, so samples can look older, not newer.
private final class Lease: @unchecked Sendable {
    private let lock = NSLock()
    private let duration: Double
    private var heartbeatAt = nativeNow()
    private var outputAt = nativeNow()
    private var anchor: (parent: Double, native: Double)?
    private var stopping: (reason: String, at: Double)?
    init(duration: Double = 5000) { self.duration = duration }
    func heartbeat(parentMs: Double, receivedAt: Double) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard parentMs.isFinite, parentMs >= 0, receivedAt.isFinite,
              anchor.map({ parentMs >= $0.parent }) ?? true,
              stopping == nil else { return false }
        anchor = (parentMs, receivedAt)
        heartbeatAt = receivedAt
        return true
    }
    func mapped(_ sampleAt: Double) -> Double? {
        lock.lock(); defer { lock.unlock() }
        guard let anchor else { return nil }
        let mapped = anchor.parent + (sampleAt - anchor.native)
        return mapped.isFinite && mapped >= 0 ? mapped : nil
    }
    func wrote(at: Double) {
        lock.lock(); defer { lock.unlock() }
        outputAt = at
    }
    func stop(_ reason: String, at: Double = nativeNow()) {
        lock.lock(); defer { lock.unlock() }
        if stopping == nil { stopping = (reason, at) }
    }
    func state(at now: Double = nativeNow()) -> (reason: String, at: Double)? {
        lock.lock(); defer { lock.unlock() }
        if stopping == nil {
            if signalStop != 0 { stopping = ("signal", now) }
            else if now - heartbeatAt >= duration { stopping = ("lease-expired", now) }
            else if now - outputAt >= duration { stopping = ("output-expired", now) }
        }
        return stopping
    }
    func watch() {
        // This thread also covers a main thread blocked in native startup.
        Thread.detachNewThread { [self] in
            while true {
                if let stopped = state(), nativeNow() - stopped.at >= 750 {
                    diagnostic("abnormal-deadline")
                    _exit(125)
                }
                Thread.sleep(forTimeInterval: 0.01)
            }
        }
        Thread.detachNewThread { [self] in
            var pending = [UInt8]()
            var chunk = [UInt8](repeating: 0, count: 512)
            while true {
                let count = chunk.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
                if count == 0 { stop("parent-disconnected"); return }
                if count < 0 {
                    if errno == EINTR { continue }
                    stop("control-failed"); return
                }
                for byte in chunk.prefix(count) {
                    if byte != 10 {
                        if pending.count == 1024 { stop("control-bound"); return }
                        pending.append(byte)
                        continue
                    }
                    let receivedAt = nativeNow()
                    guard let value = try? JSONSerialization.jsonObject(with: Data(pending)),
                          let object = value as? [String: Any],
                          object["type"] as? String == "heartbeat",
                          object["clockDomain"] as? String == "capture-monotonic",
                          let number = object["timestampMs"] as? NSNumber,
                          CFGetTypeID(number) != CFBooleanGetTypeID(),
                          heartbeat(parentMs: number.doubleValue, receivedAt: receivedAt) else {
                        stop("invalid-control"); return
                    }
                    pending.removeAll(keepingCapacity: true)
                }
            }
        }
    }
}

// At most one encoded frame is pending. Never replace a partially written line.
private final class Output {
    private let lease: Lease
    private var pending: Data?
    private var offset = 0
    init(_ lease: Lease) throws {
        self.lease = lease
        let flags = fcntl(STDOUT_FILENO, F_GETFL)
        guard flags >= 0, fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else {
            throw HelperError(reason: "output-failed")
        }
    }
    var available: Bool { pending == nil }
    func submit(_ value: [String: Any]) throws {
        guard pending == nil else { return }
        pending = try jsonLine(value)
        offset = 0
    }
    func flush() throws {
        guard let bytes = pending else { return }
        let written = bytes.withUnsafeBytes { buffer -> Int in
            guard let base = buffer.baseAddress else { return 0 }
            return Darwin.write(STDOUT_FILENO, base.advanced(by: offset), buffer.count - offset)
        }
        if written > 0 {
            offset += written
            if offset == bytes.count { pending = nil; offset = 0; lease.wrote(at: nativeNow()) }
        } else if written < 0 && errno == EPIPE {
            pending = nil; offset = 0; lease.stop("parent-disconnected")
        } else if written < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
            throw HelperError(reason: "output-failed")
        }
    }
}

private func property(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}
private func ids(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> [AudioObjectID] {
    var address = property(selector)
    var size: UInt32 = 0
    try check(AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size))
    guard size <= 65536, size % 4 == 0 else { throw HelperError(reason: "source-bound") }
    var result = [AudioObjectID](repeating: 0, count: Int(size) / 4)
    if size > 0 {
        try result.withUnsafeMutableBytes {
            try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0.baseAddress!))
        }
    }
    return result
}
private func number(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> UInt32 {
    var address = property(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value))
    return value
}
private func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
    var address = property(selector)
    var value: CFString?
    var size = UInt32(MemoryLayout<CFString?>.size)
    try withUnsafeMutablePointer(to: &value) {
        try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0))
    }
    return value.map { $0 as String } ?? ""
}
private func strings(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> [String] {
    var address = property(selector)
    var value: CFArray?
    var size = UInt32(MemoryLayout<CFArray?>.size)
    try withUnsafeMutablePointer(to: &value) {
        try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0))
    }
    guard let values = value as? [String] else { throw HelperError(reason: "device-composition") }
    return values
}

private struct Source {
    let pid: Int32
    let object: AudioObjectID
    let launch: String
    let executable: String
    var kasetAttribution = false
    func verifyAttribution() throws {
        if kasetAttribution {
            guard try string(object, kAudioProcessPropertyBundleID) == "com.apple.WebKit.GPU",
                  try kasetCacheOwned(pid) else { throw HelperError(reason: "source-loss") }
        } else if try string(object, kAudioProcessPropertyBundleID) == "com.apple.WebKit.GPU" {
            // Shared WebKit audio is never a generic process selection.
            throw HelperError(reason: "source-loss")
        }
    }
    func verify() throws {
        guard try ids(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).contains(object),
              try number(object, kAudioProcessPropertyPID) == UInt32(pid) else { throw HelperError(reason: "source-loss") }
        try verifyProcessIdentity(pid, launch: launch, executable: executable)
    }
}
private func verifyProcessIdentity(_ pid: Int32, launch: String, executable: String) throws {
    guard try launchIdentity(pid) == launch,
          try executableIdentity(pid) == executable,
          try launchIdentity(pid) == launch else { throw HelperError(reason: "source-loss") }
}
private func launchIdentity(_ pid: Int32) throws -> String {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else {
        throw HelperError(reason: "source-loss")
    }
    return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
}
private func executableIdentity(_ pid: Int32) throws -> String {
    var bytes = [UInt8](repeating: 0, count: 4096)
    let length = bytes.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
    guard length > 0 else { throw HelperError(reason: "source-loss") }
    let value = String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: pid] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
          let code else { throw HelperError(reason: "source-loss") }
    // Swift requires an explicit static reference. Check the running code first
    // so a changed file cannot silently redefine the approved executable.
    var staticCode: SecStaticCode?
    guard SecCodeCheckValidity(code, [], nil) == errSecSuccess,
          SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
          let staticCode else { throw HelperError(reason: "source-loss") }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let fields = information as? [String: Any],
          let hash = fields[kSecCodeInfoUnique as String] as? Data,
          !hash.isEmpty, hash.count <= 64 else { throw HelperError(reason: "source-loss") }
    let identity = value + "|" + hash.map { String(format: "%02x", $0) }.joined()
    guard !value.isEmpty, identity.utf8.count <= 512 else { throw HelperError(reason: "source-bound") }
    return identity
}

// Local attribution only. A mapped cache path is not a distribution guarantee.
// Inspect metadata, not memory contents. Refuse other owners and partial scans.
private let cacheOwnerPattern = try? NSRegularExpression(pattern: #"^/(?:private/)?var/folders/[^/]+/[^/]+/C/com\.apple\.WebKit\.GPU\+([^/]+)/com\.apple\.WebKit\.GPU/"#)
private func cacheOwner(_ path: String) -> String? {
    guard let regex = cacheOwnerPattern,
          let match = regex.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)),
          let range = Range(match.range(at: 1), in: path) else { return nil }
    return String(path[range])
}
private typealias RegionRead = (Int32, Int32, UInt64, UnsafeMutableRawPointer, Int32) -> Int32
private let liveRegionRead: RegionRead = { pid, flavor, address, buffer, size in
    proc_pidinfo(pid, flavor, address, buffer, size)
}
// Public libproc walk only. PROC_PIDREGIONPATHINFO is in the SDK; flavor 22 is not.
// A zero-sized record is not ownership. Skip it and continue. If the cursor cannot
// advance, the scan is incomplete and fails closed.
private func kasetCacheOwned(_ pid: Int32, read: RegionRead = liveRegionRead) throws -> Bool {
    var address: UInt64 = 0
    var owners = Set<String>()
    let until = nativeNow() + 200
    let page = max(UInt64(vm_page_size), 4096)
    for _ in 0..<4096 {
        guard nativeNow() < until else { throw HelperError(reason: "source-bound") }
        var region = proc_regionwithpathinfo()
        let size = Int32(MemoryLayout<proc_regionwithpathinfo>.size)
        errno = 0
        let count = withUnsafeMutablePointer(to: &region) {
            read(pid, PROC_PIDREGIONPATHINFO, address, UnsafeMutableRawPointer($0), size)
        }
        if count == 0 {
            guard errno == EINVAL || errno == 0 else { throw HelperError(reason: "source-loss") }
            return owners == ["com.sertacozercan.Kaset"]
        }
        guard count == size else { throw HelperError(reason: "source-loss") }
        // A query inside a region returns that region's start, which can be behind the cursor.
        if region.prp_prinfo.pri_size == 0 {
            let base = max(address, region.prp_prinfo.pri_address)
            guard base <= UInt64.max - page else { throw HelperError(reason: "source-loss") }
            let next = base + page
            guard next > address else { throw HelperError(reason: "source-loss") }
            address = next
            continue
        }
        guard region.prp_prinfo.pri_address <= UInt64.max - region.prp_prinfo.pri_size else {
            throw HelperError(reason: "source-loss")
        }
        let end = region.prp_prinfo.pri_address + region.prp_prinfo.pri_size
        guard end > address else { throw HelperError(reason: "source-loss") }
        let path = withUnsafeBytes(of: &region.prp_vip.vip_path) { bytes in
            String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        }
        if let owner = cacheOwner(path) {
            owners.insert(owner)
            if owner != "com.sertacozercan.Kaset" { return false }
        }
        address = end
    }
    throw HelperError(reason: "source-bound")
}
private func listKasetSources() throws {
    let until = nativeNow() + 2500
    Thread.detachNewThread {
        while nativeNow() < until { Thread.sleep(forTimeInterval: 0.01) }
        _exit(125)
    }
    var result = [[String: Any]]()
    for object in try ids(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList) {
        guard try string(object, kAudioProcessPropertyBundleID) == "com.apple.WebKit.GPU" else { continue }
        let value = try number(object, kAudioProcessPropertyPID)
        guard value > 0, value <= UInt32(Int32.max) else { continue }
        let pid = Int32(value)
        // One unreadable GPU process cannot hide a later proven Kaset owner.
        let owned = (try? kasetCacheOwned(pid)) ?? false
        guard owned else { continue }
        let launch = try launchIdentity(pid)
        let executable = try executableIdentity(pid)
        let source = Source(pid: pid, object: object, launch: launch, executable: executable, kasetAttribution: true)
        try source.verify()
        try source.verifyAttribution()
        guard result.count < 32 else { throw HelperError(reason: "source-bound") }
        result.append(["identity": ["kind": "native", "processIdentifier": value, "launchIdentity": launch,
                                    "executableIdentity": executable, "coreAudioObject": String(object)],
                       "runningOutput": try number(object, kAudioProcessPropertyIsRunningOutput) != 0])
    }
    FileHandle.standardOutput.write(try jsonLine(["sources": result], limit: 64 * 1024))
}

private struct Snapshot {
    let left: [Float]
    let right: [Float]
    let sampledAt: Double
    let callbacks: UInt64
}
// The callback only copies a bounded ring under a non-waiting lock.
private final class Samples: @unchecked Sendable {
    private let lock = NSLock()
    private var left = [Float](repeating: 0, count: sampleCount)
    private var right = [Float](repeating: 0, count: sampleCount)
    private var times = [Double](repeating: 0, count: sampleCount)
    private var cursor = 0
    private var frames = 0
    private var callbacks: UInt64 = 0
    func append(_ input: UnsafePointer<AudioBufferList>, time: UnsafePointer<AudioTimeStamp>, rate: Double) {
        guard time.pointee.mFlags.contains(.hostTimeValid), time.pointee.mHostTime > 0 else { return }
        let absoluteNow = mach_absolute_time()
        guard time.pointee.mHostTime <= absoluteNow else { return }
        let inputAt = nativeNow() - Double(absoluteNow - time.pointee.mHostTime) * tickMs
        guard lock.try() else { return }
        defer { lock.unlock() }
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard let first = buffers.first, let data = first.mData else { return }
        let channels = Int(first.mNumberChannels)
        guard channels == 1 || channels == 2 else { return }
        let available = Int(first.mDataByteSize) / (4 * channels)
        guard available > 0 else { return }
        let count = min(sampleCount, available)
        let a = data.assumingMemoryBound(to: Float.self)
        let second = buffers.count > 1 ? buffers[1] : nil
        let b = second?.mData?.assumingMemoryBound(to: Float.self)
        guard channels == 2 || (b != nil && second?.mNumberChannels == 1 && Int(second!.mDataByteSize) / 4 >= available) else { return }
        let start = available - count
        for index in start..<available {
            let l = a[index * channels]
            let r = channels == 2 ? a[index * 2 + 1] : b![index]
            left[cursor] = l.isFinite ? l : 0
            right[cursor] = r.isFinite ? r : 0
            times[cursor] = inputAt + Double(index) * 1000 / rate
            cursor = (cursor + 1) % sampleCount
        }
        frames = min(sampleCount, frames + count)
        callbacks = callbacks == UInt64.max ? callbacks : callbacks + 1
    }
    func snapshot() -> Snapshot? {
        lock.lock(); defer { lock.unlock() }
        guard frames == sampleCount, let oldest = times.min() else { return nil }
        return Snapshot(left: (0..<sampleCount).map { left[(cursor + $0) % sampleCount] },
                        right: (0..<sampleCount).map { right[(cursor + $0) % sampleCount] },
                        sampledAt: oldest, callbacks: callbacks)
    }
}

private final class Analyzer {
    private let setup: FFTSetup
    private var window = [Float](repeating: 0, count: sampleCount)
    init() throws {
        guard let setup = vDSP_create_fftsetup(11, FFTRadix(kFFTRadix2)) else { throw HelperError(reason: "analysis") }
        self.setup = setup
        vDSP_hann_window(&window, vDSP_Length(sampleCount), Int32(vDSP_HANN_NORM))
    }
    deinit { vDSP_destroy_fftsetup(setup) }
    func features(_ sample: Snapshot, rate: Double, lease: Lease) throws -> [String: Any]? {
        guard let timestamp = lease.mapped(sample.sampledAt) else { return nil }
        let age = nativeNow() - sample.sampledAt
        guard age.isFinite, age >= 0 else { return nil }
        let mono = zip(sample.left, sample.right).map { ($0 + $1) / 2 }
        var real = zip(mono, window).map { $0 * $1 }
        var imaginary = [Float](repeating: 0, count: sampleCount)
        real.withUnsafeMutableBufferPointer { r in
            imaginary.withUnsafeMutableBufferPointer { i in
                var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
                vDSP_fft_zip(setup, &split, 1, 11, FFTDirection(FFT_FORWARD))
            }
        }
        let bands = (0..<24).map { band -> Float in
            let upper = min(20000, rate / 2)
            let low = 30 * pow(upper / 30, Double(band) / 24)
            let high = 30 * pow(upper / 30, Double(band + 1) / 24)
            let first = max(1, min(sampleCount / 2 - 1, Int(low * Double(sampleCount) / rate)))
            let end = max(first + 1, min(sampleCount / 2, Int(ceil(high * Double(sampleCount) / rate))))
            var peak: Float = 0
            for index in first..<end { peak = max(peak, hypot(real[index], imaginary[index]) * 4 / Float(sampleCount)) }
            return min(1, max(0, (20 * log10(max(peak, 0.000000001)) + 80) / 80))
        }
        let envelope = (0..<64).map { bucket -> [String: Float] in
            let values = mono[(bucket * sampleCount / 64)..<((bucket + 1) * sampleCount / 64)]
            return ["min": min(1, max(-1, values.min() ?? 0)), "max": min(1, max(-1, values.max() ?? 0))]
        }
        func rms(_ values: [Float]) -> Float { sqrt(values.reduce(0) { $0 + $1 * $1 } / Float(values.count)) }
        func peak(_ values: [Float]) -> Float { values.reduce(0) { max($0, abs($1)) } }
        return ["timestampMs": timestamp, "sampleAgeMs": age, "clockDomain": "capture-monotonic",
                "spectrum": bands, "envelope": envelope,
                "channels": ["layout": "stereo", "rms": [rms(sample.left), rms(sample.right)], "peaks": [peak(sample.left), peak(sample.right)]]]
    }
}

private final class Cleanup { var failed = false; func record(_ status: OSStatus) { failed = failed || status != noErr } }
@available(macOS 14.2, *)
private func capture(_ source: Source, lease: Lease, cleanup: Cleanup) throws {
    var tap: AudioObjectID = 0
    var device: AudioObjectID = 0
    var proc: AudioDeviceIOProcID?
    var started = false
    defer {
        if started { cleanup.record(AudioDeviceStop(device, proc)) }
        if let proc { cleanup.record(AudioDeviceDestroyIOProcID(device, proc)) }
        if device != 0 { cleanup.record(AudioHardwareDestroyAggregateDevice(device)) }
        if tap != 0 { cleanup.record(AudioHardwareDestroyProcessTap(tap)) }
    }
    try source.verify()
    try source.verifyAttribution()
    let description = CATapDescription(stereoMixdownOfProcesses: [source.object])
    description.name = "Local music visualization"
    description.isPrivate = true
    description.isExclusive = false
    description.muteBehavior = .unmuted
    if #available(macOS 26.0, *) { description.isProcessRestoreEnabled = false }
    try check(AudioHardwareCreateProcessTap(description, &tap))
    let uid = try string(tap, kAudioTapPropertyUID)
    var format = AudioStreamBasicDescription()
    var address = property(kAudioTapPropertyFormat)
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format))
    guard format.mFormatID == kAudioFormatLinearPCM,
          format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
          format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
          format.mFormatFlags & kAudioFormatFlagIsPacked != 0,
          format.mBitsPerChannel == 32, format.mChannelsPerFrame == 2,
          format.mSampleRate >= 8000, format.mSampleRate <= 192000 else { throw HelperError(reason: "format") }
    let aggregate: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Local music observer",
        kAudioAggregateDeviceUIDKey: UUID().uuidString,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceTapAutoStartKey: false,
        kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: uid, kAudioSubTapDriftCompensationKey: true]],
    ]
    try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device))
    guard try strings(device, kAudioAggregateDevicePropertyFullSubDeviceList).isEmpty,
          try strings(device, kAudioAggregateDevicePropertyTapList) == [uid] else { throw HelperError(reason: "device-composition") }
    let samples = Samples()
    let analyzer = try Analyzer()
    let output = try Output(lease)
    let rate = format.mSampleRate
    try check(AudioDeviceCreateIOProcIDWithBlock(&proc, device, nil) { _, input, inputTime, _, _ in
        samples.append(input, time: inputTime, rate: rate)
    })
    try source.verify()
    try source.verifyAttribution()
    guard lease.state() == nil else { return }
    try check(AudioDeviceStart(device, proc))
    started = true
    var previousCallbacks: UInt64 = 0
    var nextFrameAt = nativeNow()
    var nextIdentityCheckAt = nativeNow()
    var nextAttributionCheckAt = nativeNow()
    while lease.state() == nil {
        let now = nativeNow()
        if now >= nextIdentityCheckAt {
            try source.verify()
            nextIdentityCheckAt = now + 50
        }
        if now >= nextAttributionCheckAt {
            try source.verifyAttribution()
            nextAttributionCheckAt = now + 500
        }
        try output.flush()
        if output.available, now >= nextFrameAt, let sample = samples.snapshot(), sample.callbacks != previousCallbacks,
           let features = try analyzer.features(sample, rate: rate, lease: lease) {
            previousCallbacks = sample.callbacks
            nextFrameAt = now + 50
            try output.submit(features)
            try output.flush()
        }
        Thread.sleep(forTimeInterval: 0.005)
    }
}

private func selfTest(_ scenario: String, duration: Double) throws {
    if scenario == "attribution" {
        let path = "/var/folders/aa/bb/C/com.apple.WebKit.GPU+com.sertacozercan.Kaset/com.apple.WebKit.GPU/cache"
        guard cacheOwner(path) == "com.sertacozercan.Kaset",
              cacheOwner("/private" + path) == "com.sertacozercan.Kaset",
              cacheOwner(path.replacingOccurrences(of: "com.sertacozercan.Kaset", with: "other.app")) == "other.app",
              cacheOwner("/tmp" + path) == nil,
              cacheOwner(path.replacingOccurrences(of: "/cache", with: "-other/cache")) == nil,
              try !kasetCacheOwned(getpid()) else { throw HelperError(reason: "attribution-fixture") }
        // The public walk can report a zero-sized region before a later cache file.
        // Only a positive-size public record can prove ownership. Flavor 22 is not consulted.
        final class Served { var cache = false }
        let served = Served()
        let readFixture: RegionRead = { _, flavor, address, buffer, size in
            guard flavor == PROC_PIDREGIONPATHINFO else {
                errno = EINVAL
                return 0
            }
            let region = buffer.assumingMemoryBound(to: proc_regionwithpathinfo.self)
            region.pointee = proc_regionwithpathinfo()
            if address == 0 {
                region.pointee.prp_prinfo.pri_address = 4096
                region.pointee.prp_prinfo.pri_size = 0
                return size
            }
            if address > 4096, !served.cache {
                served.cache = true
                region.pointee.prp_prinfo.pri_address = address
                region.pointee.prp_prinfo.pri_size = 4096
                let bytes = Array(path.utf8)
                withUnsafeMutableBytes(of: &region.pointee.prp_vip.vip_path) { target in
                    target.copyBytes(from: bytes)
                }
                return size
            }
            errno = EINVAL
            return 0
        }
        guard try kasetCacheOwned(0, read: readFixture) else { throw HelperError(reason: "attribution-fixture") }
        let overlapServed = Served()
        let overlap: RegionRead = { _, flavor, address, buffer, size in
            guard flavor == PROC_PIDREGIONPATHINFO else {
                errno = EINVAL
                return 0
            }
            let region = buffer.assumingMemoryBound(to: proc_regionwithpathinfo.self)
            region.pointee = proc_regionwithpathinfo()
            if address == 0 {
                region.pointee.prp_prinfo.pri_address = 4096
                region.pointee.prp_prinfo.pri_size = 0
                return size
            }
            if !overlapServed.cache, address > 4096 {
                overlapServed.cache = true
                region.pointee.prp_prinfo.pri_address = 4096
                region.pointee.prp_prinfo.pri_size = address
                let bytes = Array(path.utf8)
                withUnsafeMutableBytes(of: &region.pointee.prp_vip.vip_path) { target in
                    target.copyBytes(from: bytes)
                }
                return size
            }
            errno = EINVAL
            return 0
        }
        guard try kasetCacheOwned(0, read: overlap) else { throw HelperError(reason: "attribution-fixture") }
        let deniedAfterMatch: RegionRead = { _, flavor, address, buffer, size in
            guard flavor == PROC_PIDREGIONPATHINFO else {
                errno = EINVAL
                return 0
            }
            if address == 0 {
                let region = buffer.assumingMemoryBound(to: proc_regionwithpathinfo.self)
                region.pointee = proc_regionwithpathinfo()
                region.pointee.prp_prinfo.pri_address = 4096
                region.pointee.prp_prinfo.pri_size = 4096
                let bytes = Array(path.utf8)
                withUnsafeMutableBytes(of: &region.pointee.prp_vip.vip_path) { target in
                    target.copyBytes(from: bytes)
                }
                return size
            }
            errno = EACCES
            return 0
        }
        let zeroSized: RegionRead = { _, flavor, address, buffer, size in
            guard flavor == PROC_PIDREGIONPATHINFO else {
                errno = EINVAL
                return 0
            }
            let region = buffer.assumingMemoryBound(to: proc_regionwithpathinfo.self)
            region.pointee = proc_regionwithpathinfo()
            region.pointee.prp_prinfo.pri_address = address
            region.pointee.prp_prinfo.pri_size = 0
            let bytes = Array(path.utf8)
            withUnsafeMutableBytes(of: &region.pointee.prp_vip.vip_path) { target in
                target.copyBytes(from: bytes)
            }
            return size
        }
        let foreign: RegionRead = { _, flavor, address, buffer, size in
            guard flavor == PROC_PIDREGIONPATHINFO else {
                errno = EINVAL
                return 0
            }
            let region = buffer.assumingMemoryBound(to: proc_regionwithpathinfo.self)
            region.pointee = proc_regionwithpathinfo()
            region.pointee.prp_prinfo.pri_address = address == 0 ? 4096 : address
            region.pointee.prp_prinfo.pri_size = 4096
            let foreignPath = path.replacingOccurrences(of: "com.sertacozercan.Kaset", with: "other.app")
            let bytes = Array(foreignPath.utf8)
            withUnsafeMutableBytes(of: &region.pointee.prp_vip.vip_path) { target in
                target.copyBytes(from: bytes)
            }
            return size
        }
        guard (try? kasetCacheOwned(0, read: deniedAfterMatch)) == nil,
              (try? kasetCacheOwned(0, read: zeroSized)) == nil,
              (try? kasetCacheOwned(0, read: foreign)) == false else { throw HelperError(reason: "attribution-fixture") }
        FileHandle.standardOutput.write(try jsonLine(["test": "attribution", "passed": true]))
        return
    }
    if scenario == "identity" {
        let launch = try launchIdentity(getpid())
        let executable = try executableIdentity(getpid())
        let parts = executable.split(separator: "|", omittingEmptySubsequences: false)
        guard launch.split(separator: ":").count == 2, parts.count == 2,
              parts[0].hasPrefix("/"), !parts[1].isEmpty,
              parts[1].allSatisfy({ $0.isHexDigit }),
              (try? launchIdentity(Int32.max)) == nil,
              (try? executableIdentity(Int32.max)) == nil else { throw HelperError(reason: "identity-fixture") }
        try verifyProcessIdentity(getpid(), launch: launch, executable: executable)
        guard (try? verifyProcessIdentity(getpid(), launch: launch + "-changed", executable: executable)) == nil,
              (try? verifyProcessIdentity(getpid(), launch: launch, executable: executable + "-changed")) == nil else { throw HelperError(reason: "identity-fixture") }
        FileHandle.standardOutput.write(try jsonLine(["test": "identity", "passed": true]))
        return
    }
    if scenario == "clock" {
        let lease = Lease()
        guard lease.heartbeat(parentMs: 1000, receivedAt: 5000), lease.mapped(4500) == 500,
              lease.heartbeat(parentMs: 2000, receivedAt: 6200), lease.mapped(4500) == 300,
              !lease.heartbeat(parentMs: 1999, receivedAt: 6201), lease.mapped(4500) == 300,
              !lease.heartbeat(parentMs: .nan, receivedAt: 6201) else { throw HelperError(reason: "clock-fixture") }
        FileHandle.standardOutput.write(try jsonLine(["test": "clock", "passed": true]))
        return
    }
    let lease = Lease(duration: duration)
    lease.watch()
    if scenario == "startup-blocked" {
        while true { Thread.sleep(forTimeInterval: 0.1) }
    }
    let analyzer = try Analyzer()
    let output = try Output(lease)
    let tone = (0..<sampleCount).map { Float(0.25 * sin(2 * Double.pi * 1000 * Double($0) / 48000)) }
    let zero = [Float](repeating: 0, count: sampleCount)
    let heldAt = nativeNow() - 50
    var nextAt = nativeNow()
    var frames: UInt64 = 0
    while lease.state() == nil {
        try output.flush()
        let now = nativeNow()
        if output.available, now >= nextAt {
            let sample = Snapshot(left: scenario == "silence" ? zero : tone, right: zero,
                                  sampledAt: scenario == "held-sample" ? heldAt : now - 50, callbacks: frames)
            if let features = try analyzer.features(sample, rate: 48000, lease: lease) {
                try output.submit(features)
                try output.flush()
                frames += 1
                nextAt = now + (scenario == "blocked-output" ? 1 : 50)
            }
        }
        Thread.sleep(forTimeInterval: 0.001)
    }
    reportLeaseStop(lease)
}

private func reportLeaseStop(_ lease: Lease) {
    guard let stopped = lease.state() else { return }
    diagnostic(stopped.reason)
    if stopped.reason == "lease-expired" || stopped.reason == "output-expired" { exit(124) }
    if stopped.reason != "signal" && stopped.reason != "parent-disconnected" { exit(1) }
}

private func main() throws {
    guard timebaseStatus == KERN_SUCCESS, tickMs.isFinite, tickMs > 0 else { throw HelperError(reason: "clock") }
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["--list-kaset-sources"] { try listKasetSources(); return }
    if args.count == 2 || args.count == 4, args.first == "--self-test" {
        guard ["clock", "identity", "attribution", "stream", "silence", "held-sample", "startup-blocked", "blocked-output"].contains(args[1]) else { throw HelperError(reason: "arguments") }
        var duration: Double = 5000
        if args.count == 4 {
            guard args[2] == "--test-lease-ms", let value = Double(args[3]), value >= 100, value <= 5000 else { throw HelperError(reason: "arguments") }
            duration = value
        }
        try selfTest(args[1], duration: duration)
        return
    }
    guard args.count == 10 || args.count == 12, args[0] == "--protocol", args[1] == "1",
          args[2] == "--process-id", let pid = Int32(args[3]), pid > 0,
          args[4] == "--launch-identity", !args[5].isEmpty, args[5].utf8.count <= 512,
          args[6] == "--executable-identity", !args[7].isEmpty, args[7].utf8.count <= 512,
          args[8] == "--core-audio-object", let object = UInt32(args[9]), object > 0 else { throw HelperError(reason: "arguments") }
    if args.count == 12 {
        guard args[10] == "--attribution", args[11] == "kaset-cache-v1" else { throw HelperError(reason: "arguments") }
    }
    guard #available(macOS 14.2, *) else { throw HelperError(reason: "unsupported") }
    let lease = Lease()
    let cleanup = Cleanup()
    lease.watch()
    do {
        try capture(Source(pid: pid, object: object, launch: args[5], executable: args[7], kasetAttribution: args.count == 12), lease: lease, cleanup: cleanup)
    } catch {
        if cleanup.failed {
            diagnostic("capture-failed")
            throw HelperError(reason: "cleanup-failed")
        }
        throw error
    }
    if cleanup.failed { throw HelperError(reason: "cleanup-failed") }
    reportLeaseStop(lease)
}
do { try main() }
catch {
    let reason = (error as? HelperError)?.reason ?? "setup"
    diagnostic(reason)
    exit(reason == "cleanup-failed" ? 70 : 1)
}
