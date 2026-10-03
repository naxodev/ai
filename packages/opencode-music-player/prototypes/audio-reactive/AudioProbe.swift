// LOCAL PROTOTYPE. No microphone, files, playback commands, or global tap.
import Foundation
import CoreAudio
import AudioToolbox
import Accelerate
import AVFoundation
import Darwin

var stopRequested: sig_atomic_t = 0
signal(SIGINT) { _ in stopRequested = 1 }
signal(SIGTERM) { _ in stopRequested = 1 }
signal(SIGPIPE, SIG_IGN)

struct ProbeError: Error, CustomStringConvertible {
    let description: String
}

func check(_ status: OSStatus, _ operation: String) throws {
    if status != noErr { throw ProbeError(description: "\(operation): OSStatus \(status)") }
}

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func ids(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> [AudioObjectID] {
    var property = address(selector)
    var size: UInt32 = 0
    try check(AudioObjectGetPropertyDataSize(object, &property, 0, nil, &size), "property size")
    guard size <= 64 * 1024, size % 4 == 0 else { throw ProbeError(description: "invalid property size") }
    var result = [AudioObjectID](repeating: 0, count: Int(size) / 4)
    if size > 0 {
        try result.withUnsafeMutableBytes { bytes in
            try check(AudioObjectGetPropertyData(object, &property, 0, nil, &size, bytes.baseAddress!), "property values")
        }
    }
    return result
}

func number(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> UInt32 {
    var property = address(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    try check(AudioObjectGetPropertyData(object, &property, 0, nil, &size, &value), "numeric property")
    return value
}

func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
    var property = address(selector)
    var value: CFString?
    var size = UInt32(MemoryLayout<CFString?>.size)
    try withUnsafeMutablePointer(to: &value) { pointer in
        try check(AudioObjectGetPropertyData(object, &property, 0, nil, &size, pointer), "string property")
    }
    return value.map { $0 as String } ?? ""
}

func strings(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> [String] {
    var property = address(selector)
    var value: CFArray?
    var size = UInt32(MemoryLayout<CFArray?>.size)
    try withUnsafeMutablePointer(to: &value) { pointer in
        try check(AudioObjectGetPropertyData(object, &property, 0, nil, &size, pointer), "array property")
    }
    guard let result = value as? [String] else { throw ProbeError(description: "unverifiable device composition") }
    return result
}

func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return }
    let line = data + Data([10])
    line.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count && stopRequested == 0 {
            let written = Darwin.write(STDOUT_FILENO, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if written > 0 { offset += written }
            else if errno != EINTR { stopRequested = 1 }
        }
    }
}

struct Source {
    let object: AudioObjectID
    let pid: UInt32
    let bundle: String
}

func sources() throws -> [Source] {
    try ids(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).compactMap { object in
        guard let pid = try? number(object, kAudioProcessPropertyPID), pid > 0 else { return nil }
        return Source(object: object, pid: pid, bundle: (try? string(object, kAudioProcessPropertyBundleID)) ?? "")
    }
}

func processName(_ pid: UInt32) -> String {
    var bytes = [UInt8](repeating: 0, count: 4096)
    let length = bytes.withUnsafeMutableBytes { buffer in
        proc_pidpath(Int32(pid), buffer.baseAddress, UInt32(buffer.count))
    }
    guard length > 0 else { return "process-\(pid)" }
    let path = String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
    return URL(fileURLWithPath: path).lastPathComponent
}

// Quiet synthetic output in a separate process, used only for isolation tests.
// AVAudioEngine never opens its input node. Nothing is recorded or saved.
func testTone(seconds: Double) throws {
    let engine = AVAudioEngine()
    guard let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2) else {
        throw ProbeError(description: "cannot create tone format")
    }
    let node = AVAudioSourceNode(format: format) { _, time, count, list in
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        let offset = time.pointee.mSampleTime.isFinite ? time.pointee.mSampleTime : 0
        for buffer in buffers {
            guard let data = buffer.mData, buffer.mDataByteSize >= count * buffer.mNumberChannels * 4 else { return -50 }
            let samples = data.assumingMemoryBound(to: Float.self)
            for frame in 0..<Int(count) {
                let value = Float(0.01 * sin(2 * Double.pi * 1200 * (offset + Double(frame)) / 48_000))
                for channel in 0..<Int(buffer.mNumberChannels) { samples[frame * Int(buffer.mNumberChannels) + channel] = value }
            }
        }
        return noErr
    }
    engine.attach(node)
    engine.connect(node, to: engine.mainMixerNode, format: format)
    DispatchQueue.global().asyncAfter(deadline: .now() + seconds + 2) { _exit(124) }
    try engine.start()
    defer { engine.stop() }
    emit(["type": "status", "state": "quiet-synthetic-tone", "pid": getpid(), "notMusic": true])
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    while ProcessInfo.processInfo.systemUptime < deadline && stopRequested == 0 { Thread.sleep(forTimeInterval: 0.02) }
}

func verify(_ selected: [Source]) throws {
    let current = try ids(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList)
    guard selected.allSatisfy({ original in current.contains(original.object)
        && (try? number(original.object, kAudioProcessPropertyPID)) == original.pid
        && (try? string(original.object, kAudioProcessPropertyBundleID)) == original.bundle }) else {
        throw ProbeError(description: "source identity changed; capture stopped")
    }
}

// The callback only copies a bounded window. It never waits for the worker.
final class Samples: @unchecked Sendable {
    let lock = NSLock()
    let count = 2048
    var left = [Float](repeating: 0, count: 2048)
    var right = [Float](repeating: 0, count: 2048)
    var cursor = 0
    var frames = 0
    var callbacks = 0
    var lastSampleTime = 0.0

    func append(_ list: UnsafePointer<AudioBufferList>) {
        guard lock.try() else { return }
        defer { lock.unlock() }
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        guard let first = buffers.first, let firstData = first.mData else { return }
        let channels = Int(first.mNumberChannels)
        guard channels == 1 || channels == 2 else { return }
        let available = min(count, Int(first.mDataByteSize) / (4 * channels))
        let a = firstData.assumingMemoryBound(to: Float.self)
        let second = buffers.count > 1 ? buffers[1] : nil
        let b = second?.mData?.assumingMemoryBound(to: Float.self)
        guard channels == 2 || (b != nil && second?.mNumberChannels == 1) else { return }
        for i in 0..<available {
            let l = a[i * channels]
            let r = channels == 2 ? a[i * 2 + 1] :
                (b != nil && Int(second!.mDataByteSize) / 4 > i ? b![i] : l)
            left[cursor] = l.isFinite ? l : 0
            right[cursor] = r.isFinite ? r : 0
            cursor = (cursor + 1) % count
        }
        frames = min(count, frames + available)
        callbacks += 1
        lastSampleTime = ProcessInfo.processInfo.systemUptime
    }

    func snapshot() -> (left: [Float], right: [Float], callbacks: Int, age: Double)? {
        lock.lock()
        defer { lock.unlock() }
        guard frames == count else { return nil }
        return ((0..<count).map { left[(cursor + $0) % count] },
                (0..<count).map { right[(cursor + $0) % count] },
                callbacks, ProcessInfo.processInfo.systemUptime - lastSampleTime)
    }
}

func features(_ left: [Float], _ right: [Float], _ rate: Double) -> [String: Any] {
    let n = left.count
    let mono = zip(left, right).map { ($0 + $1) / 2 }
    var window = [Float](repeating: 0, count: n)
    vDSP_hann_window(&window, vDSP_Length(n), Int32(vDSP_HANN_NORM))
    var real = [Float](repeating: 0, count: n)
    var imaginary = [Float](repeating: 0, count: n)
    for i in 0..<n { real[i] = mono[i] * window[i] }
    let setup = vDSP_create_fftsetup(vDSP_Length(log2(Double(n))), FFTRadix(kFFTRadix2))!
    defer { vDSP_destroy_fftsetup(setup) }
    real.withUnsafeMutableBufferPointer { r in
        imaginary.withUnsafeMutableBufferPointer { i in
            var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
            vDSP_fft_zip(setup, &split, 1, vDSP_Length(log2(Double(n))), FFTDirection(FFT_FORWARD))
        }
    }
    let bands = (0..<24).map { band -> Float in
        let upper = min(20_000.0, rate / 2)
        let low = 30 * pow(upper / 30, Double(band) / 24)
        let high = 30 * pow(upper / 30, Double(band + 1) / 24)
        let start = max(1, min(n / 2 - 1, Int(low * Double(n) / rate)))
        let end = max(start + 1, min(n / 2, Int(ceil(high * Double(n) / rate))))
        var peak: Float = 0
        for i in start..<end { peak = max(peak, hypot(real[i], imaginary[i]) * 4 / Float(n)) }
        return min(1, max(0, (20 * log10(max(peak, 0.000_000_001)) + 80) / 80))
    }
    let waveform = (0..<64).map { bucket -> [Float] in
        let samples = mono[(bucket * n / 64)..<((bucket + 1) * n / 64)]
        return [min(1, max(-1, samples.min() ?? 0)), min(1, max(-1, samples.max() ?? 0))]
    }
    func rms(_ values: [Float]) -> Float { sqrt(values.reduce(0) { $0 + $1 * $1 } / Float(values.count)) }
    func peak(_ values: [Float]) -> Float { values.map { abs($0) }.max() ?? 0 }
    return ["type": "features", "bands": bands, "waveform": waveform,
            "rms": [rms(left), rms(right)], "peaks": [peak(left), peak(right)],
            "sampleRate": rate, "timeMs": ProcessInfo.processInfo.systemUptime * 1000]
}

@available(macOS 14.2, *)
func capture(_ selected: [Source], deadline: Double) throws {
    let description = CATapDescription(stereoMixdownOfProcesses: selected.map(\.object))
    description.name = "Local music visualization prototype"
    description.isPrivate = true
    description.isExclusive = false
    description.muteBehavior = .unmuted
    if #available(macOS 26.0, *) { description.isProcessRestoreEnabled = false }
    var tap: AudioObjectID = 0
    try check(AudioHardwareCreateProcessTap(description, &tap), "create process tap")
    defer { AudioHardwareDestroyProcessTap(tap) }
    let uid = try string(tap, kAudioTapPropertyUID)
    var format = AudioStreamBasicDescription()
    var property = address(kAudioTapPropertyFormat)
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try check(AudioObjectGetPropertyData(tap, &property, 0, nil, &size, &format), "tap format")
    guard format.mFormatID == kAudioFormatLinearPCM,
          format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
          format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
          format.mFormatFlags & kAudioFormatFlagIsPacked != 0,
          format.mBitsPerChannel == 32, format.mChannelsPerFrame == 2,
          format.mSampleRate >= 8_000, format.mSampleRate <= 192_000 else {
        throw ProbeError(description: "unsupported tap sample format")
    }
    // No hardware subdevices: input streams can only come from this private tap.
    let aggregateDescription: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Local music observer prototype",
        kAudioAggregateDeviceUIDKey: UUID().uuidString,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceTapAutoStartKey: false,
        kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: uid, kAudioSubTapDriftCompensationKey: true]],
    ]
    var device: AudioObjectID = 0
    try check(AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &device), "create tap-only aggregate")
    defer { AudioHardwareDestroyAggregateDevice(device) }
    guard try strings(device, kAudioAggregateDevicePropertyFullSubDeviceList).isEmpty,
          try strings(device, kAudioAggregateDevicePropertyTapList) == [uid] else {
        throw ProbeError(description: "refusing aggregate with hardware subdevices")
    }
    let samples = Samples()
    var proc: AudioDeviceIOProcID?
    try check(AudioDeviceCreateIOProcIDWithBlock(&proc, device, nil) { _, input, _, _, _ in samples.append(input) }, "create I/O callback")
    defer { if let proc { AudioDeviceDestroyIOProcID(device, proc) } }
    emit(["type": "status", "state": "starting", "sourcePIDs": selected.map(\.pid),
          "scope": "All output audio from explicitly selected process objects; no automatic rebinding."])
    try verify(selected)
    guard stopRequested == 0, ProcessInfo.processInfo.systemUptime < deadline else {
        throw ProbeError(description: "capture cancelled or deadline reached before startup")
    }
    try check(AudioDeviceStart(device, proc), "start tap-only input")
    var ioStarted = true
    defer { if ioStarted { AudioDeviceStop(device, proc) } }
    var previousCallbacks = 0
    var sawSignal = false
    while ProcessInfo.processInfo.systemUptime < deadline && stopRequested == 0 {
        try verify(selected)
        if let snapshot = samples.snapshot(), snapshot.callbacks != previousCallbacks, snapshot.age < 0.5 {
            previousCallbacks = snapshot.callbacks
            sawSignal = sawSignal || snapshot.left.contains { abs($0) > 0.000_001 } || snapshot.right.contains { abs($0) > 0.000_001 }
            var event = features(snapshot.left, snapshot.right, format.mSampleRate)
            event["callbacks"] = snapshot.callbacks
            event["ageMs"] = snapshot.age * 1000
            emit(event)
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    try check(AudioDeviceStop(device, proc), "stop tap-only input")
    ioStarted = false
    emit(["type": "status", "state": "stopped", "callbacks": previousCallbacks, "nonzeroSignalObserved": sawSignal])
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["--self-test"] {
        let n = 2048
        let tone = (0..<n).map { Float(0.25 * sin(2 * Double.pi * 1000 * Double($0) / 48_000)) }
        let zero = [Float](repeating: 0, count: n)
        emit(["type": "status", "state": "synthetic-self-test", "notLiveAudio": true])
        emit(features(tone, zero, 48_000))
        emit(features(zero, zero, 48_000))
    } else if args == ["--list"] {
        emit(["type": "sources", "processes": try sources().map {
            ["object": $0.object, "pid": $0.pid, "bundle": $0.bundle, "name": processName($0.pid),
             "runningOutput": (try? number($0.object, kAudioProcessPropertyIsRunningOutput)) == 1] as [String: Any]
        }])
    } else if args.count == 2, args[0] == "--tone", let duration = Double(args[1]), duration > 0, duration <= 5 {
        try testTone(seconds: duration)
    } else if (args.count == 4 || args.count == 6), args[0] == "--pid", args[2] == "--seconds",
              let duration = Double(args[3]), duration > 0, duration <= 30 {
        let requested = args[1].split(separator: ",").compactMap { UInt32($0) }
        guard !requested.isEmpty, requested.count <= 8,
              requested.count == args[1].split(separator: ",").count else {
            throw ProbeError(description: "specify one to eight valid source PIDs")
        }
        let available = try sources()
        let selected = requested.compactMap { pid in available.first { $0.pid == pid } }
        guard selected.count == requested.count else { throw ProbeError(description: "source is not a Core Audio output process") }
        if args.count == 6 {
            guard args[4] == "--object", requested.count == 1,
                  let expected = UInt32(args[5]), selected[0].object == expected else {
                throw ProbeError(description: "selected audio process object changed before startup")
            }
        }
        guard #available(macOS 14.2, *) else { throw ProbeError(description: "macOS 14.2+ required") }
        // Independent hard deadline covers startup and blocked output. Parent also
        // enforces a deadline; this is not a production resource supervisor.
        let deadline = ProcessInfo.processInfo.systemUptime + duration
        DispatchQueue.global().asyncAfter(deadline: .now() + duration) { _exit(124) }
        // Leave a small cleanup window, but never extend audio I/O past the
        // requested hard deadline to accommodate startup or stdout blocking.
        try capture(selected, deadline: deadline - 0.25)
    } else {
        throw ProbeError(description: "Use --list, --self-test, --tone 1..5, or --pid PID[,PID] --seconds 1..30")
    }
} catch {
    emit(["type": "error", "message": String(describing: error)])
    exit(1)
}
