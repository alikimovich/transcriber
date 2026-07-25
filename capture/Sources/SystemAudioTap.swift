// System-output capture via a Core Audio process tap.
//
// The tap can be scoped to specific processes, which is the whole reason this
// is native: the interviewer channel can be limited to the meeting app so
// music and notification sounds never reach the transcript.
//
// Two things here are load-bearing and non-obvious (see SPIKE.md):
//   - the aggregate device must be anchored to a real output device for its
//     clock, or AudioDeviceCreateIOProcIDWithBlock hangs forever with no error
//   - no callbacks at all is a *normal* state (target silent), distinct from
//     callbacks full of zeroes (missing permission)

import AVFoundation
import CoreAudio
import Foundation

final class SystemAudioTap {
    enum TapError: Error, CustomStringConvertible {
        case createTapFailed(OSStatus)
        case tapUIDUnavailable
        case noDefaultOutputDevice
        case createAggregateFailed(OSStatus)
        case createIOProcFailed(OSStatus)
        case startFailed(OSStatus)
        case unsupportedFormat

        var description: String {
            switch self {
            case .createTapFailed(let s): return "AudioHardwareCreateProcessTap failed: \(fourCC(s))"
            case .tapUIDUnavailable: return "could not read the tap's UID"
            case .noDefaultOutputDevice: return "no default output device to use as a clock source"
            case .createAggregateFailed(let s):
                return "AudioHardwareCreateAggregateDevice failed: \(fourCC(s))"
            case .createIOProcFailed(let s):
                return "AudioDeviceCreateIOProcIDWithBlock failed: \(fourCC(s))"
            case .startFailed(let s): return "AudioDeviceStart failed: \(fourCC(s))"
            case .unsupportedFormat: return "tap reported a format we can't read"
            }
        }
    }

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private(set) var format: AVAudioFormat?

    /// Called on Core Audio's realtime thread. Keep the work short.
    private let onBuffer: (AVAudioPCMBuffer) -> Void

    init(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) {
        self.onBuffer = onBuffer
    }

    deinit { stop() }

    /// Starts capture. Pass process object IDs to scope the tap, or an empty
    /// array to capture everything.
    func start(processObjectIDs: [AudioObjectID]) throws {
        let description: CATapDescription
        if processObjectIDs.isEmpty {
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        } else {
            description = CATapDescription(stereoMixdownOfProcesses: processObjectIDs)
        }
        description.name = "Interview Lens"
        description.isPrivate = true
        description.muteBehavior = .unmuted  // never interfere with what the user hears

        let tapStatus = AudioHardwareCreateProcessTap(description, &tapID)
        guard tapStatus == noErr, tapID != kAudioObjectUnknown else {
            throw TapError.createTapFailed(tapStatus)
        }

        guard let tapUID = caReadString(tapID, kAudioTapPropertyUID) else {
            throw TapError.tapUIDUnavailable
        }
        guard let outputUID = AudioProcesses.defaultOutputDeviceUID() else {
            throw TapError.noDefaultOutputDevice
        }

        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "Interview Lens Capture",
            kAudioAggregateDeviceUIDKey as String:
                "com.alikimovich.interview-lens.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey as String: outputUID,
            kAudioAggregateDeviceClockDeviceKey as String: outputUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceSubDeviceListKey as String: [
                [kAudioSubDeviceUIDKey as String: outputUID]
            ],
            kAudioAggregateDeviceTapListKey as String: [
                [
                    kAudioSubTapUIDKey as String: tapUID,
                    kAudioSubTapDriftCompensationKey as String: true,
                ]
            ],
        ]

        let aggStatus = AudioHardwareCreateAggregateDevice(
            aggregateDescription as CFDictionary, &aggregateID)
        guard aggStatus == noErr, aggregateID != kAudioObjectUnknown else {
            throw TapError.createAggregateFailed(aggStatus)
        }

        guard
            var asbd = caRead(
                tapID, caAddress(kAudioTapPropertyFormat), AudioStreamBasicDescription.self),
            let avFormat = AVAudioFormat(streamDescription: &asbd)
        else {
            throw TapError.unsupportedFormat
        }
        format = avFormat

        let handler = onBuffer
        let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) {
            _, inInputData, _, _, _ in
            guard
                let buffer = AVAudioPCMBuffer(
                    pcmFormat: avFormat,
                    bufferListNoCopy: inInputData,
                    deallocator: nil)
            else { return }
            handler(buffer)
        }
        guard ioStatus == noErr, let ioProcID else {
            throw TapError.createIOProcFailed(ioStatus)
        }

        // First run triggers the system-audio permission prompt here.
        let startStatus = AudioDeviceStart(aggregateID, ioProcID)
        guard startStatus == noErr else { throw TapError.startFailed(startStatus) }
    }

    func stop() {
        if let ioProcID, aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
            self.ioProcID = nil
        }
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }
}
