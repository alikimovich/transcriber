// Thin typed wrappers over the Core Audio property API, plus process
// enumeration. Extracted from the capture spike (see SPIKE.md).

import CoreAudio
import Foundation

func caAddress(
    _ selector: AudioObjectPropertySelector,
    _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

/// Reads a variable-length property into an array of trivial values.
func caReadArray<T>(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress, _: T.Type)
    -> [T]
{
    var a = address
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &a, 0, nil, &size) == noErr, size > 0 else {
        return []
    }
    let count = Int(size) / MemoryLayout<T>.stride
    let buf = UnsafeMutablePointer<T>.allocate(capacity: count)
    defer { buf.deallocate() }
    guard AudioObjectGetPropertyData(object, &a, 0, nil, &size, buf) == noErr else { return [] }
    return Array(UnsafeBufferPointer(start: buf, count: count))
}

/// Reads a fixed-size property.
func caRead<T>(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress, _: T.Type) -> T? {
    var a = address
    var size = UInt32(MemoryLayout<T>.size)
    let raw = UnsafeMutableRawPointer.allocate(
        byteCount: Int(size), alignment: MemoryLayout<T>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(object, &a, 0, nil, &size, raw) == noErr else { return nil }
    return raw.assumingMemoryBound(to: T.self).pointee
}

func caReadString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    guard let cf = caRead(object, caAddress(selector), CFString?.self) ?? nil else { return nil }
    return cf as String
}

/// Turns an OSStatus into a readable four-character code where possible.
func fourCC(_ status: OSStatus) -> String {
    let n = UInt32(bitPattern: status)
    let bytes = [n >> 24, n >> 16, n >> 8, n].map { UInt8($0 & 0xFF) }
    if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) {
        return "'\(String(decoding: bytes, as: UTF8.self))' (\(status))"
    }
    return "\(status)"
}

// MARK: - Audio-producing processes

struct AudioProcess {
    let objectID: AudioObjectID
    let pid: pid_t
    let bundleID: String
    let isRunningOutput: Bool

    var name: String {
        var buf = [CChar](repeating: 0, count: 4096)
        if proc_name(pid, &buf, UInt32(buf.count)) > 0 {
            return String(cString: buf)
        }
        return bundleID.isEmpty ? "pid \(pid)" : bundleID
    }
}

enum AudioProcesses {
    static func all() -> [AudioProcess] {
        let ids = caReadArray(
            AudioObjectID(kAudioObjectSystemObject),
            caAddress(kAudioHardwarePropertyProcessObjectList),
            AudioObjectID.self)

        return ids.compactMap { id in
            guard let pid = caRead(id, caAddress(kAudioProcessPropertyPID), pid_t.self) else {
                return nil
            }
            return AudioProcess(
                objectID: id,
                pid: pid,
                bundleID: caReadString(id, kAudioProcessPropertyBundleID) ?? "",
                isRunningOutput: (caRead(
                    id, caAddress(kAudioProcessPropertyIsRunningOutput), UInt32.self) ?? 0) != 0)
        }
    }

    /// Processes currently producing output — the useful shortlist when picking
    /// a meeting app to tap.
    static func outputting() -> [AudioProcess] {
        all().filter(\.isRunningOutput)
    }

    static func matching(pids: [pid_t]) -> [AudioProcess] {
        all().filter { pids.contains($0.pid) }
    }

    /// Resolves processes whose name or bundle ID contains `needle`, case-insensitively.
    static func search(_ needle: String) -> [AudioProcess] {
        let n = needle.lowercased()
        return all().filter {
            $0.name.lowercased().contains(n) || $0.bundleID.lowercased().contains(n)
        }
    }

    /// UID of the default output device. Required as the aggregate device's
    /// clock source — see SPIKE.md; without it the IO thread never starts.
    static func defaultOutputDeviceUID() -> String? {
        guard
            let deviceID = caRead(
                AudioObjectID(kAudioObjectSystemObject),
                caAddress(kAudioHardwarePropertyDefaultOutputDevice),
                AudioObjectID.self)
        else { return nil }
        return caReadString(deviceID, kAudioDevicePropertyDeviceUID)
    }
}
