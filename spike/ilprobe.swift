// ilprobe — risk spike for Transcriber.
//
// Answers three questions before any real code gets written:
//   1. Can we enumerate audio-producing processes and map them to PIDs?
//   2. Can we create a Core Audio process tap scoped to specific processes?
//   3. Does a signed *CLI binary* (not a .app bundle) with an embedded
//      Info.plist get the system-audio TCC grant?
//
// Usage:
//   ilprobe list                 list processes currently producing audio
//   ilprobe tap [pid ...]        tap those PIDs (or everything) for 5s, report level

import AudioToolbox
import CoreAudio
import Foundation

// MARK: - Core Audio property helpers

func addr(
    _ selector: AudioObjectPropertySelector,
    _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

/// Reads a variable-length property into an array of `T`.
func readArray<T>(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress, _: T.Type)
    -> [T]
{
    var a = address
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &a, 0, nil, &size) == noErr, size > 0 else {
        return []
    }
    var out = [T](unsafeUninitializedCapacity: Int(size) / MemoryLayout<T>.size) { _, c in
        c = Int(size) / MemoryLayout<T>.size
    }
    guard AudioObjectGetPropertyData(object, &a, 0, nil, &size, &out) == noErr else { return [] }
    return out
}

/// Reads a fixed-size property of type `T`.
func read<T>(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress, _: T.Type) -> T? {
    var a = address
    var size = UInt32(MemoryLayout<T>.size)
    let raw = UnsafeMutableRawPointer.allocate(
        byteCount: Int(size), alignment: MemoryLayout<T>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(object, &a, 0, nil, &size, raw) == noErr else { return nil }
    return raw.assumingMemoryBound(to: T.self).pointee
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    guard let cf = read(object, addr(selector), CFString?.self) ?? nil else { return nil }
    return cf as String
}

// MARK: - Process enumeration

struct AudioProcess {
    let objectID: AudioObjectID
    let pid: pid_t
    let bundleID: String
    let isRunningOutput: Bool

    /// Best-effort human name, resolved from the running application list.
    var name: String {
        if let app = NSRunningApplicationName(pid) { return app }
        if !bundleID.isEmpty { return bundleID }
        return "pid \(pid)"
    }
}

func NSRunningApplicationName(_ pid: pid_t) -> String? {
    // Avoid an AppKit dependency in the probe; ask the process table instead.
    var name = [CChar](repeating: 0, count: 4096)
    guard proc_name(pid, &name, UInt32(name.count)) > 0 else { return nil }
    return String(cString: name)
}

func audioProcesses() -> [AudioProcess] {
    let ids = readArray(
        AudioObjectID(kAudioObjectSystemObject),
        addr(kAudioHardwarePropertyProcessObjectList),
        AudioObjectID.self)

    return ids.compactMap { id in
        guard let pid = read(id, addr(kAudioProcessPropertyPID), pid_t.self) else { return nil }
        let bundle = readString(id, kAudioProcessPropertyBundleID) ?? ""
        let running =
            (read(id, addr(kAudioProcessPropertyIsRunningOutput), UInt32.self) ?? 0) != 0
        return AudioProcess(
            objectID: id, pid: pid, bundleID: bundle, isRunningOutput: running)
    }
}

/// UID of the current default output device — the clock source for our aggregate.
func defaultOutputDeviceUID() -> String? {
    guard
        let deviceID = read(
            AudioObjectID(kAudioObjectSystemObject),
            addr(kAudioHardwarePropertyDefaultOutputDevice),
            AudioObjectID.self)
    else { return nil }
    return readString(deviceID, kAudioDevicePropertyDeviceUID)
}

// MARK: - Tap + aggregate device

/// Shared level accumulator written by the realtime IOProc.
/// Deliberately a plain global: the IOProc runs on a realtime thread and must
/// not touch Swift runtime locks.
nonisolated(unsafe) var gPeak: Float = 0
nonisolated(unsafe) var gSumSquares: Double = 0
nonisolated(unsafe) var gSampleCount: Int = 0

func runTap(pids: [pid_t], seconds: Double) -> Int32 {
    stage("enumerating audio processes")
    let all = audioProcesses()
    let targets: [AudioObjectID]
    if pids.isEmpty {
        targets = []
        print("Tapping: ALL system output (global mixdown)")
    } else {
        targets = all.filter { pids.contains($0.pid) }.map(\.objectID)
        guard !targets.isEmpty else {
            FileHandle.standardError.write(
                Data("no audio process objects found for pids \(pids)\n".utf8))
            return 2
        }
        let names = all.filter { pids.contains($0.pid) }.map(\.name).joined(separator: ", ")
        print("Tapping: \(names)")
    }

    // A stereo mixdown tap. With an empty exclude-list this is a global tap;
    // with explicit process object IDs it is scoped to just those processes.
    let desc: CATapDescription
    if targets.isEmpty {
        desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    } else {
        desc = CATapDescription(stereoMixdownOfProcesses: targets)
    }
    desc.name = "Transcriber Probe Tap"
    desc.isPrivate = true
    desc.muteBehavior = .unmuted  // capture without muting the user's playback

    var tapID = AudioObjectID(kAudioObjectUnknown)
    stage("calling AudioHardwareCreateProcessTap")
    let tapStatus = AudioHardwareCreateProcessTap(desc, &tapID)
    stage("tap create returned \(fourCC(tapStatus))")
    guard tapStatus == noErr, tapID != kAudioObjectUnknown else {
        FileHandle.standardError.write(
            Data("AudioHardwareCreateProcessTap failed: \(fourCC(tapStatus))\n".utf8))
        return 3
    }
    defer { AudioHardwareDestroyProcessTap(tapID) }
    print("Tap created (objectID \(tapID))")

    guard let tapUID = readString(tapID, kAudioTapPropertyUID) else {
        FileHandle.standardError.write(Data("could not read tap UID\n".utf8))
        return 4
    }

    // Wrap the tap in a private aggregate device so we can pull an IO stream.
    //
    // The aggregate MUST be anchored to a real output device: it supplies the
    // clock that drives the IO thread. A tap-only aggregate with an empty
    // sub-device list has no timing source and AudioDeviceCreateIOProcIDWithBlock
    // hangs forever with no error and no TCC prompt.
    guard let outputUID = defaultOutputDeviceUID() else {
        FileHandle.standardError.write(Data("could not resolve default output device\n".utf8))
        return 5
    }
    stage("anchoring aggregate to output device \(outputUID)")

    let aggUID = "com.alikimovich.transcriber.probe.\(UUID().uuidString)"
    let aggDesc: [String: Any] = [
        kAudioAggregateDeviceNameKey as String: "Transcriber Probe",
        kAudioAggregateDeviceUIDKey as String: aggUID,
        kAudioAggregateDeviceMainSubDeviceKey as String: outputUID,
        kAudioAggregateDeviceClockDeviceKey as String: outputUID,
        kAudioAggregateDeviceIsPrivateKey as String: true,
        kAudioAggregateDeviceIsStackedKey as String: false,
        kAudioAggregateDeviceTapAutoStartKey as String: true,
        kAudioAggregateDeviceSubDeviceListKey as String: [
            [kAudioSubDeviceUIDKey as String: outputUID]
        ],
        kAudioAggregateDeviceTapListKey as String: [
            [kAudioSubTapUIDKey as String: tapUID, kAudioSubTapDriftCompensationKey as String: true]
        ],
    ]

    var aggID = AudioObjectID(kAudioObjectUnknown)
    stage("calling AudioHardwareCreateAggregateDevice")
    let aggStatus = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
    stage("aggregate create returned \(fourCC(aggStatus))")
    guard aggStatus == noErr, aggID != kAudioObjectUnknown else {
        FileHandle.standardError.write(
            Data("AudioHardwareCreateAggregateDevice failed: \(fourCC(aggStatus))\n".utf8))
        return 5
    }
    defer { AudioHardwareDestroyAggregateDevice(aggID) }
    print("Aggregate device created (objectID \(aggID))")

    if let fmt = read(tapID, addr(kAudioTapPropertyFormat), AudioStreamBasicDescription.self) {
        print(
            "Tap format: \(Int(fmt.mSampleRate)) Hz, \(fmt.mChannelsPerFrame) ch, "
                + "\(fmt.mBitsPerChannel)-bit")
    }

    gPeak = 0
    gSumSquares = 0
    gSampleCount = 0

    var procID: AudioDeviceIOProcID?
    stage("calling AudioDeviceCreateIOProcIDWithBlock")
    let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) {
        _, inInputData, _, _, _ in
        let bufferList = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: inInputData))
        for buffer in bufferList {
            guard let raw = buffer.mData else { continue }
            let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            let samples = raw.assumingMemoryBound(to: Float.self)
            for i in 0..<count {
                let v = samples[i]
                let a = abs(v)
                if a > gPeak { gPeak = a }
                gSumSquares += Double(v) * Double(v)
            }
            gSampleCount += count
        }
    }
    guard ioStatus == noErr, let procID else {
        FileHandle.standardError.write(
            Data("AudioDeviceCreateIOProcIDWithBlock failed: \(fourCC(ioStatus))\n".utf8))
        return 6
    }
    defer { AudioDeviceDestroyIOProcID(aggID, procID) }

    // THIS is the call that triggers the TCC prompt on first run.
    stage("calling AudioDeviceStart (TCC prompt fires here on first run)")
    let startStatus = AudioDeviceStart(aggID, procID)
    stage("AudioDeviceStart returned \(fourCC(startStatus))")
    guard startStatus == noErr else {
        FileHandle.standardError.write(
            Data("AudioDeviceStart failed: \(fourCC(startStatus))\n".utf8))
        return 7
    }
    print("Capturing for \(seconds)s — play some audio now…\n")

    stage("entering capture loop")
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        // Plain sleep, not RunLoop.run: this thread has no input sources, and
        // the IOProc is driven by CoreAudio's own realtime thread.
        usleep(250_000)
        let rms = gSampleCount > 0 ? sqrt(gSumSquares / Double(gSampleCount)) : 0
        // Floor at -120 dB rather than -inf: Int(-Double.infinity) is a runtime
        // trap in Swift, and silence is the *expected* state before audio starts.
        let db = rms > 0 ? max(-120.0, 20 * log10(rms)) : -120.0
        let bars = Int((max(0.0, min(1.0, (db + 60) / 60)) * 40).rounded())
        let meter = String(repeating: "█", count: bars) + String(repeating: "·", count: 40 - bars)
        let label = rms > 0 ? String(format: "%6.1f dB", db) : "  silent"
        FileHandle.standardError.write(Data("\r  \(meter)  \(label)".utf8))
    }
    AudioDeviceStop(aggID, procID)
    FileHandle.standardError.write(Data("\n\n".utf8))

    let rms = gSampleCount > 0 ? sqrt(gSumSquares / Double(gSampleCount)) : 0
    print("Frames seen : \(gSampleCount)")
    print("Peak        : \(String(format: "%.6f", gPeak))")
    print("RMS         : \(String(format: "%.6f", rms))")

    if gSampleCount == 0 {
        print("\nRESULT: DEAD STREAM — no callbacks at all.")
        print("        Aggregate device never delivered audio.")
        return 10
    }
    if gPeak == 0 {
        print("\nRESULT: SILENT STREAM — callbacks fired but every sample was zero.")
        print("        This is the signature of a missing system-audio TCC grant.")
        print("        Check: System Settings > Privacy & Security > Screen & System Audio Recording")
        return 11
    }
    print("\nRESULT: OK — real audio captured from a signed CLI binary.")
    return 0
}

func fourCC(_ status: OSStatus) -> String {
    let n = UInt32(bitPattern: status)
    let bytes = [n >> 24, n >> 16, n >> 8, n].map { UInt8($0 & 0xFF) }
    if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) {
        return "'\(String(decoding: bytes, as: UTF8.self))' (\(status))"
    }
    return "\(status)"
}

// MARK: - Entry point

// stdout is block-buffered when redirected; a hang would otherwise swallow
// every diagnostic we printed before it.
setvbuf(stdout, nil, _IONBF, 0)

/// Stage tracing on stderr (always unbuffered), so a hang tells us *where*.
func stage(_ s: String) {
    FileHandle.standardError.write(Data("[stage] \(s)\n".utf8))
}

// Hard watchdog: never let the probe hang a shell.
let watchdog = Thread {
    Thread.sleep(forTimeInterval: 20)
    FileHandle.standardError.write(Data("[stage] WATCHDOG: 20s elapsed, aborting\n".utf8))
    exit(99)
}
watchdog.start()

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "list":
    let procs = audioProcesses().sorted {
        ($0.isRunningOutput ? 0 : 1, $0.name) < ($1.isRunningOutput ? 0 : 1, $1.name)
    }
    guard !procs.isEmpty else {
        print("No audio process objects reported. (Is anything playing?)")
        exit(1)
    }
    print(String(format: "%-8@ %-6@ %s", "PID" as NSString, "OUT" as NSString, "NAME / BUNDLE"))
    for p in procs {
        let flag = p.isRunningOutput ? "▶" : " "
        print(String(format: "%-8d %-6@ %@", p.pid, flag as NSString, p.name as NSString))
    }
    exit(0)

case "tap":
    let pids = args.dropFirst().compactMap { pid_t($0) }
    exit(runTap(pids: pids, seconds: 5))

default:
    print(
        """
        ilprobe — Transcriber capture spike

          ilprobe list              list audio-producing processes
          ilprobe tap               tap all system output for 5s
          ilprobe tap <pid> [pid…]  tap only those processes for 5s
        """)
    exit(64)
}
