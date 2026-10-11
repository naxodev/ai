// Discovery only. This file and its composed prefix contain no capture implementation.
import Cocoa
import ScreenCaptureKit
import CryptoKit

private let kasetIdentifier = "com.sertacozercan.Kaset"
private let kasetBundlePath = "/Applications/Kaset.app"
private let kasetExecutablePath = kasetBundlePath + "/Contents/MacOS/Kaset"
private struct ApplicationProfile: Codable, Equatable {
    let revision: Int
    let bundleIdentifier: String
    let bundlePath: String
    let executablePath: String
    let architecture: String
    let teamIdentifier: String
    let cdHash: String
    let requirement: String
}
private struct ApplicationIdentity: Equatable {
    let pid: Int32
    let launch: String
    let executable: String
}
private struct ApplicationSnapshot {
    let identity: ApplicationIdentity
    let bundleIdentifier: String
    let bundlePath: String
    let executablePath: String
}
private func appFailure(_ checkpoint: String) throws -> Never {
    diagnostic(checkpoint)
    throw HelperError(reason: "source-loss")
}
private func appChecked<T>(_ checkpoint: String, _ operation: () throws -> T) rethrows -> T {
    do { return try operation() }
    catch { diagnostic(checkpoint); throw error }
}
private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
private var appArchitecture: String {
    #if arch(arm64)
    return "arm64"
    #else
    return "x86_64"
    #endif
}
private func canonical(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
}
private func validateProfile(_ profile: ApplicationProfile) throws {
    guard profile.revision == 1, profile.bundleIdentifier == kasetIdentifier,
          profile.bundlePath == kasetBundlePath, profile.executablePath == kasetExecutablePath,
          profile.architecture == appArchitecture,
          profile.teamIdentifier.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil,
          profile.cdHash.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
          !profile.requirement.isEmpty, profile.requirement.utf8.count <= 4096 else {
        throw HelperError(reason: "application-profile")
    }
}
private func profileRequirement(_ profile: ApplicationProfile) throws -> SecRequirement {
    var result: SecRequirement?
    guard SecRequirementCreateWithString(profile.requirement as CFString, [], &result) == errSecSuccess,
          let result else { throw HelperError(reason: "application-profile") }
    return result
}
private func signingFields(_ code: SecStaticCode) throws -> (identifier: String, team: String, hash: String) {
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let fields = information as? [String: Any],
          let identifier = fields[kSecCodeInfoIdentifier as String] as? String,
          let team = fields[kSecCodeInfoTeamIdentifier as String] as? String,
          let hash = fields[kSecCodeInfoUnique as String] as? Data, hash.count == 20 else {
        throw HelperError(reason: "application-signature")
    }
    return (identifier, team, hex(hash))
}
private func validateSigningFields(_ fields: (identifier: String, team: String, hash: String),
                                   _ profile: ApplicationProfile) throws {
    guard fields.identifier == profile.bundleIdentifier, fields.team == profile.teamIdentifier,
          fields.hash == profile.cdHash else { throw HelperError(reason: "application-signature") }
}
private func diskCode() throws -> SecStaticCode {
    guard canonical(kasetBundlePath) == kasetBundlePath, canonical(kasetExecutablePath) == kasetExecutablePath else {
        throw HelperError(reason: "application-profile")
    }
    var result: SecStaticCode?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: kasetBundlePath) as CFURL, [], &result) == errSecSuccess,
          let result else { throw HelperError(reason: "application-signature") }
    return result
}
private func validateDiskCode(_ code: SecStaticCode, _ requirement: SecRequirement?) throws {
    let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSCheckAllArchitectures)
    guard SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess else {
        throw HelperError(reason: "application-signature")
    }
}
private func prepareApplicationProfile() throws {
    let code = try diskCode()
    try validateDiskCode(code, nil)
    let fields = try signingFields(code)
    var requirement: SecRequirement?
    var text: CFString?
    guard SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess, let requirement,
          SecRequirementCopyString(requirement, [], &text) == errSecSuccess, let text else {
        throw HelperError(reason: "application-profile")
    }
    let profile = ApplicationProfile(revision: 1, bundleIdentifier: fields.identifier,
        bundlePath: kasetBundlePath, executablePath: kasetExecutablePath, architecture: appArchitecture,
        teamIdentifier: fields.team, cdHash: fields.hash, requirement: text as String)
    try validateProfile(profile)
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(profile) + Data([10]))
}
private func decodeApplicationProfile(_ bytes: Data, digest: String) throws -> ApplicationProfile {
    guard bytes.count <= 16384, hex(Data(SHA256.hash(data: bytes))) == digest else {
        throw HelperError(reason: "application-profile")
    }
    let result = try JSONDecoder().decode(ApplicationProfile.self, from: bytes)
    try validateProfile(result)
    return result
}
private func loadApplicationProfile() throws -> ApplicationProfile {
    // Fixed path and compiled digest. No argument can select a profile or signing policy.
    let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: applicationProfilePath))
    defer { try? handle.close() }
    return try decodeApplicationProfile(handle.read(upToCount: 16385) ?? Data(), digest: applicationProfileDigest)
}
private func validateSnapshot(_ snapshot: ApplicationSnapshot, profile: ApplicationProfile,
                              expected: ApplicationIdentity?) throws {
    guard snapshot.identity.pid > 0, snapshot.bundleIdentifier == profile.bundleIdentifier,
          snapshot.bundlePath == profile.bundlePath, snapshot.executablePath == profile.executablePath,
          snapshot.identity.executable == profile.executablePath + "|" + profile.cdHash,
          expected.map({ $0 == snapshot.identity }) ?? true else { throw HelperError(reason: "source-loss") }
}
private func singleApplication<T>(_ values: [T]) throws -> T {
    guard values.count == 1, let value = values.first else { throw HelperError(reason: "source-loss") }
    return value
}
private func verifiedApplication(_ profile: ApplicationProfile, expected: ApplicationIdentity? = nil) throws -> ApplicationIdentity {
    // Query afresh. An NSRunningApplication object can outlive the actual process.
    let candidate = try singleApplication(NSRunningApplication.runningApplications(withBundleIdentifier: kasetIdentifier))
    guard !candidate.isTerminated, candidate.bundleIdentifier == kasetIdentifier,
          let bundle = candidate.bundleURL, let executable = candidate.executableURL else {
        throw HelperError(reason: "source-loss")
    }
    let pid = candidate.processIdentifier
    let launch = try launchIdentity(pid)
    let identity = ApplicationIdentity(pid: pid, launch: launch, executable: try executableIdentity(pid))
    try validateSnapshot(ApplicationSnapshot(identity: identity, bundleIdentifier: candidate.bundleIdentifier ?? "",
        bundlePath: canonical(bundle.path), executablePath: canonical(executable.path)), profile: profile, expected: expected)
    let requirement = try profileRequirement(profile)
    let disk = try diskCode()
    try validateDiskCode(disk, requirement)
    try validateSigningFields(signingFields(disk), profile)
    var running: SecCode?
    let attributes = [kSecGuestAttributePid as String: pid] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &running) == errSecSuccess, let running,
          SecCodeCheckValidity(running, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else {
        throw HelperError(reason: "application-signature")
    }
    var staticRunning: SecStaticCode?
    guard SecCodeCopyStaticCode(running, [], &staticRunning) == errSecSuccess, let staticRunning else {
        throw HelperError(reason: "application-signature")
    }
    try validateSigningFields(signingFields(staticRunning), profile)
    try verifyProcessIdentity(pid, launch: launch, executable: identity.executable)
    return identity
}
private func verifySingleWitness(_ source: Source) throws {
    var matches = [AudioObjectID]()
    for object in try ids(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList) {
        guard try string(object, kAudioProcessPropertyBundleID) == "com.apple.WebKit.GPU" else { continue }
        let value = try number(object, kAudioProcessPropertyPID)
        guard value > 0, value <= UInt32(Int32.max), (try? kasetCacheOwned(Int32(value))) == true else { continue }
        matches.append(object)
        guard matches.count <= 1 else { throw HelperError(reason: "source-loss") }
    }
    guard try singleApplication(matches) == source.object else { throw HelperError(reason: "source-loss") }
    try source.verify(); try source.verifyAttribution()
}
private func withApplicationDiscovery<Content, Result>(verifyApplication: () throws -> Void,
    verifyWitness: () throws -> Void, discover: () throws -> Content, use: (Content) throws -> Result) throws -> Result {
    try appChecked("application-before-identity", verifyApplication)
    try appChecked("application-before-witness", verifyWitness)
    let content = try appChecked("application-discovery", discover)
    try appChecked("application-after-identity", verifyApplication)
    try appChecked("application-after-witness", verifyWitness)
    return try use(content)
}
private struct DiscoveredApplication { let pid: Int32; let bundleIdentifier: String }
private func checkApplicationMatch(_ identity: ApplicationIdentity, applications: [DiscoveredApplication], displayCount: Int) throws {
    let matches = applications.filter { $0.bundleIdentifier == kasetIdentifier }
    guard matches.count == 1 else { try appFailure("application-match-count") }
    guard matches.first?.pid == identity.pid else { try appFailure("application-match-pid") }
    guard displayCount > 0, displayCount <= 65536, applications.count <= 65536 else { try appFailure("application-display") }
}
private final class ApplicationContentCompletion {
    private let lock = NSLock()
    private var result: Result<SCShareableContent, Error>?
    func finish(_ value: Result<SCShareableContent, Error>) { lock.lock(); defer { lock.unlock() }; if result == nil { result = value } }
    func read() -> Result<SCShareableContent, Error>? { lock.lock(); defer { lock.unlock() }; return result }
}
private func applicationShareableContent(_ lease: Lease) throws -> SCShareableContent {
    let completion = ApplicationContentCompletion()
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, error in
        if let error { completion.finish(.failure(error)) }
        else if let content { completion.finish(.success(content)) }
        else { completion.finish(.failure(HelperError(reason: "setup"))) }
    }
    while completion.read() == nil {
        guard lease.state() == nil else { throw HelperError(reason: "prototype-deadline") }
        _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005))
    }
    guard let result = completion.read() else { throw HelperError(reason: "setup") }
    return try result.get()
}
private func inspectApplication(_ source: Source, expected: ApplicationIdentity, lease: Lease) throws {
    let profile = try loadApplicationProfile()
    let summary = try withApplicationDiscovery(verifyApplication: {
        guard try loadApplicationProfile() == profile else { throw HelperError(reason: "application-profile") }
        _ = try verifiedApplication(profile, expected: expected)
    }, verifyWitness: { try verifySingleWitness(source) }, discover: { try applicationShareableContent(lease) }) { content in
        let applications = content.applications.map { DiscoveredApplication(pid: $0.processID, bundleIdentifier: $0.bundleIdentifier) }
        try checkApplicationMatch(expected, applications: applications, displayCount: content.displays.count)
        return ["event": "sck-application-discovery", "scope": "kaset-application",
                "applicationChecks": "passed-before-and-after", "witnessChecks": "passed-before-and-after",
                "matchingApplications": 1, "witnessMatches": applications.filter { $0.pid == source.pid }.count,
                "displayCount": content.displays.count] as [String: Any]
    }
    guard lease.state() == nil else { throw HelperError(reason: "prototype-deadline") }
    FileHandle.standardOutput.write(try jsonLine(summary, limit: 4096))
}
private func applicationPolicyFixture() throws {
    let profile = ApplicationProfile(revision: 1, bundleIdentifier: kasetIdentifier, bundlePath: kasetBundlePath,
        executablePath: kasetExecutablePath, architecture: appArchitecture, teamIdentifier: "ABCDEFGHIJ",
        cdHash: String(repeating: "a", count: 40), requirement: "identifier \"com.sertacozercan.Kaset\"")
    let identity = ApplicationIdentity(pid: 42, launch: "100:0", executable: kasetExecutablePath + "|" + profile.cdHash)
    func reject(_ operation: () throws -> Void) throws {
        do { try operation() } catch { return }
        throw HelperError(reason: "application-fixture")
    }
    try validateProfile(profile)
    let bytes = try JSONEncoder().encode(profile)
    let digest = hex(Data(SHA256.hash(data: bytes)))
    guard try decodeApplicationProfile(bytes, digest: digest) == profile else { throw HelperError(reason: "application-fixture") }
    try reject { _ = try decodeApplicationProfile(bytes + Data([32]), digest: digest) }
    try reject { _ = try decodeApplicationProfile(Data(repeating: 32, count: 16385), digest: digest) }
    try validateSigningFields((kasetIdentifier, profile.teamIdentifier, profile.cdHash), profile)
    for fields in [("other.app", profile.teamIdentifier, profile.cdHash),
                   (kasetIdentifier, "OTHERTEAM1", profile.cdHash), (kasetIdentifier, profile.teamIdentifier, "changed")] {
        try reject { try validateSigningFields(fields, profile) }
    }
    try validateSnapshot(ApplicationSnapshot(identity: identity, bundleIdentifier: kasetIdentifier,
        bundlePath: kasetBundlePath, executablePath: kasetExecutablePath), profile: profile, expected: identity)
    for changed in [ApplicationIdentity(pid: 43, launch: identity.launch, executable: identity.executable),
                    ApplicationIdentity(pid: 42, launch: "101:0", executable: identity.executable),
                    ApplicationIdentity(pid: 42, launch: identity.launch, executable: identity.executable + "changed")] {
        try reject { try validateSnapshot(ApplicationSnapshot(identity: changed, bundleIdentifier: kasetIdentifier,
            bundlePath: kasetBundlePath, executablePath: kasetExecutablePath), profile: profile, expected: identity) }
    }
    try reject { try validateSnapshot(ApplicationSnapshot(identity: identity, bundleIdentifier: "spoofed.app",
        bundlePath: kasetBundlePath, executablePath: kasetExecutablePath), profile: profile, expected: identity) }
    try reject { try validateSnapshot(ApplicationSnapshot(identity: identity, bundleIdentifier: kasetIdentifier,
        bundlePath: "/other/Kaset.app", executablePath: kasetExecutablePath), profile: profile, expected: identity) }
    for values in [[Int](), [1, 2]] { try reject { _ = try singleApplication(values) } }
    try checkApplicationMatch(identity, applications: [DiscoveredApplication(pid: 42, bundleIdentifier: kasetIdentifier)], displayCount: 1)
    for applications in [[DiscoveredApplication](), [DiscoveredApplication(pid: 43, bundleIdentifier: kasetIdentifier)],
                         [DiscoveredApplication(pid: 42, bundleIdentifier: "spoofed.app")],
                         [DiscoveredApplication(pid: 42, bundleIdentifier: kasetIdentifier), DiscoveredApplication(pid: 43, bundleIdentifier: kasetIdentifier)]] {
        try reject { try checkApplicationMatch(identity, applications: applications, displayCount: 1) }
    }
    try reject { try checkApplicationMatch(identity, applications: [DiscoveredApplication(pid: 42, bundleIdentifier: kasetIdentifier)], displayCount: 0) }
}
private func applicationFlowFixture() throws {
    var phases = [String]()
    let value = try withApplicationDiscovery(verifyApplication: { phases.append("app") }, verifyWitness: { phases.append("witness") },
        discover: { phases.append("discovery"); return 7 }, use: { phases.append("use"); return $0 })
    guard value == 7, phases == ["app", "witness", "discovery", "app", "witness", "use"] else { throw HelperError(reason: "application-fixture") }
    for failed in [0, 1, 3, 4] {
        var step = 0; var used = false
        let verify = { () throws -> Void in
            defer { step += 1 }
            if step == failed { throw HelperError(reason: "source-loss") }
        }
        do {
            _ = try withApplicationDiscovery(verifyApplication: verify, verifyWitness: verify,
                discover: { step += 1; return 7 }, use: { used = true; return $0 })
            throw HelperError(reason: "application-fixture")
        } catch {
            guard !used, (error as? HelperError)?.reason == "source-loss" else { throw HelperError(reason: "application-fixture") }
        }
    }
}
private func applicationWitnessArguments(_ args: [String]) throws -> Source {
    guard args.count == 12, args[0] == "--protocol", args[1] == "1",
          args[2] == "--process-id", let pid = Int32(args[3]), pid > 0,
          args[4] == "--launch-identity", !args[5].isEmpty, args[5].utf8.count <= 512,
          args[6] == "--executable-identity", !args[7].isEmpty, args[7].utf8.count <= 512,
          args[8] == "--core-audio-object", let object = UInt32(args[9]), object > 0,
          args[10] == "--attribution", args[11] == "kaset-cache-v1" else { throw HelperError(reason: "arguments") }
    return Source(pid: pid, object: object, launch: args[5], executable: args[7], kasetAttribution: true)
}
private func applicationIdentityArguments(_ args: [String]) throws -> ApplicationIdentity {
    guard args.count == 6, args[0] == "--application-id", let pid = Int32(args[1]), pid > 0,
          args[2] == "--application-launch", !args[3].isEmpty, args[3].utf8.count <= 512,
          args[4] == "--application-executable", !args[5].isEmpty, args[5].utf8.count <= 512 else { throw HelperError(reason: "arguments") }
    return ApplicationIdentity(pid: pid, launch: args[3], executable: args[5])
}
private func applicationMain() throws {
    guard timebaseStatus == KERN_SUCCESS, tickMs.isFinite, tickMs > 0 else { throw HelperError(reason: "clock") }
    let args = Array(CommandLine.arguments.dropFirst())
    #if PROFILE_PREPARATION
    guard args == ["--prepare-profile"] else { throw HelperError(reason: "arguments") }
    try prepareApplicationProfile()
    #else
    if args == ["--self-test", "application-policy"] { try applicationPolicyFixture(); return }
    if args == ["--self-test", "application-flow"] { try applicationFlowFixture(); return }
    if args == ["--list-kaset-sources"] { _ = try loadApplicationProfile(); try listKasetSources(); return }
    let preflight = args.first == "--check-kaset-application"
    guard preflight || args.first == "--discover-kaset-application",
          args.count == (preflight ? 13 : 19) else { throw HelperError(reason: "arguments") }
    let source = try applicationWitnessArguments(Array(args[1...12]))
    if preflight {
        let profile = try loadApplicationProfile()
        try verifySingleWitness(source)
        let application = try verifiedApplication(profile)
        FileHandle.standardOutput.write(try jsonLine(["event": "sck-application-preflight", "scope": "kaset-application",
            "identity": ["processIdentifier": application.pid, "launchIdentity": application.launch,
                         "executableIdentity": application.executable]], limit: 4096))
        return
    }
    let lease = Lease(); lease.watch()
    try inspectApplication(source, expected: applicationIdentityArguments(Array(args[13...18])), lease: lease)
    #endif
}
// Applies to metadata, protected discovery, and fixtures. No unbounded native operation.
let applicationDeadline = nativeNow() + 10000
Thread.detachNewThread {
    while nativeNow() < applicationDeadline { Thread.sleep(forTimeInterval: 0.01) }
    diagnostic("abnormal-deadline"); _exit(125)
}
do { try applicationMain() }
catch {
    let native = error as NSError
    let reason = native.domain == SCStreamErrorDomain && native.code == SCStreamError.Code.userDeclined.rawValue
        ? "permission" : (error as? HelperError)?.reason ?? "setup"
    diagnostic(reason)
    exit(reason == "permission" ? 77 : 1)
}
