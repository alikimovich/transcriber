// System-output capture via a Core Audio process tap.
//
// The tap can be scoped to specific processes, which is the whole reason this
// is native: the system-audio (them) channel can be limited to the meeting app
// so music and notification sounds never reach the transcript.
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

    // The format the IOProc's buffers are actually in, which is NOT reliably
    // what kAudioTapPropertyFormat claims — see the comment in start(). Read on
    // the realtime IO thread, replaced from a property listener when the device
    // changes profile mid-session, hence the lock (same pattern as LevelMeter).
    private let wrapLock = NSLock()
    private var wrapFormat: AVAudioFormat?
    private var tapBufferIndex = 0
    private var monitoredStream = AudioObjectID(kAudioObjectUnknown)
    private var streamListener: AudioObjectPropertyListenerBlock?

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

        // What format are the IOProc's buffers in? kAudioTapPropertyFormat
        // describes the mixdown as the *tap* defines it — NOT necessarily the
        // stream the *aggregate* delivers. When the output device runs a
        // different rate or layout (AirPods drop to 24 kHz mono in hands-free
        // profile during a call), the aggregate's input stream follows the
        // device while the tap property keeps claiming 48 kHz stereo. Wrapping
        // buffers with the claimed format then reads 4× too many frames per
        // second: chipmunked, untranscribable audio that the recorder pads
        // with rhythmic silence. Diagnosed from a real corrupted recording —
        // trust the aggregate's own input stream, fall back to the tap claim
        // only if the stream can't be read.
        let tapClaim = caRead(
            tapID, caAddress(kAudioTapPropertyFormat), AudioStreamBasicDescription.self)

        let inputStreams = caReadArray(
            aggregateID,
            caAddress(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput),
            AudioObjectID.self)
        for (i, stream) in inputStreams.enumerated() {
            if let f = caRead(
                stream, caAddress(kAudioStreamPropertyVirtualFormat),
                AudioStreamBasicDescription.self)
            {
                note(
                    "aggregate input stream \(i): \(Int(f.mSampleRate)) Hz, "
                        + "\(f.mChannelsPerFrame) ch")
            }
        }
        if let c = tapClaim {
            note("tap property claims: \(Int(c.mSampleRate)) Hz, \(c.mChannelsPerFrame) ch")
        }

        // Sub-device streams come first in the aggregate, tap streams are
        // appended — so the tap's data is the last input stream, and the last
        // buffer in the IOProc's list.
        tapBufferIndex = max(0, inputStreams.count - 1)
        monitoredStream =
            inputStreams.isEmpty ? AudioObjectID(kAudioObjectUnknown) : inputStreams[tapBufferIndex]

        let streamASBD: AudioStreamBasicDescription? =
            monitoredStream != kAudioObjectUnknown
            ? caRead(
                monitoredStream, caAddress(kAudioStreamPropertyVirtualFormat),
                AudioStreamBasicDescription.self)
            : nil
        guard
            var asbd = streamASBD ?? tapClaim,
            let avFormat = AVAudioFormat(streamDescription: &asbd)
        else {
            throw TapError.unsupportedFormat
        }
        format = avFormat
        wrapFormat = avFormat
        if let claim = tapClaim, streamASBD != nil,
            claim.mSampleRate != asbd.mSampleRate
                || claim.mChannelsPerFrame != asbd.mChannelsPerFrame
        {
            note(
                "tap claim disagrees with the delivered stream — using the stream "
                    + "(\(Int(asbd.mSampleRate)) Hz, \(asbd.mChannelsPerFrame) ch)")
        }

        // The device can change profile mid-session (AirPods entering
        // hands-free when a call starts), which changes the stream format under
        // us. Track it: downstream converters rebuild whenever a buffer's
        // declared format changes, so updating the wrap format here is enough.
        if monitoredStream != kAudioObjectUnknown {
            var addr = caAddress(kAudioStreamPropertyVirtualFormat)
            let stream = monitoredStream
            let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
                guard let self else { return }
                let changed = caRead(
                    stream, caAddress(kAudioStreamPropertyVirtualFormat),
                    AudioStreamBasicDescription.self)
                guard var c = changed, let f = AVAudioFormat(streamDescription: &c) else { return }
                self.wrapLock.lock()
                self.wrapFormat = f
                self.wrapLock.unlock()
                note("tap stream format changed: \(Int(c.mSampleRate)) Hz, \(c.mChannelsPerFrame) ch")
            }
            if AudioObjectAddPropertyListenerBlock(stream, &addr, DispatchQueue.global(), listener)
                == noErr
            {
                streamListener = listener
            }
        }

        let handler = onBuffer
        let lock = wrapLock
        let index = tapBufferIndex
        let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) {
            [weak self] _, inInputData, _, _, _ in
            lock.lock()
            let fmt = self?.wrapFormat
            lock.unlock()
            guard let fmt else { return }

            // Wrap only the tap's buffer: on devices with an input side (a
            // headset microphone) the aggregate's buffer list also carries the
            // device's own input streams, and the tap is the last entry.
            let listPtr = UnsafeMutablePointer(mutating: inInputData)
            let buffers = UnsafeMutableAudioBufferListPointer(listPtr)
            let buffer: AVAudioPCMBuffer?
            if buffers.count == 1 || index >= buffers.count || !fmt.isInterleaved {
                // Single stream, or a layout we can't safely slice: wrap as-is.
                buffer = AVAudioPCMBuffer(
                    pcmFormat: fmt, bufferListNoCopy: inInputData, deallocator: nil)
            } else {
                var single = AudioBufferList(mNumberBuffers: 1, mBuffers: buffers[index])
                buffer = AVAudioPCMBuffer(
                    pcmFormat: fmt, bufferListNoCopy: &single, deallocator: nil)
            }
            guard let buffer else { return }
            handler(buffer)
        }
        guard ioStatus == noErr, let ioProcID else {
            throw TapError.createIOProcFailed(ioStatus)
        }

        // Let the aggregate device settle before starting IO. Without this the
        // tap intermittently delivers callbacks full of zeroes — roughly one
        // run in three in testing — which is indistinguishable from a missing
        // permission grant.
        Thread.sleep(forTimeInterval: 0.3)

        // First run triggers the system-audio permission prompt here.
        let startStatus = AudioDeviceStart(aggregateID, ioProcID)
        guard startStatus == noErr else { throw TapError.startFailed(startStatus) }
    }

    /// Starts capture and reports whether real audio is flowing.
    ///
    /// Roughly one process launch in three brings the tap up silent: callbacks
    /// arrive at the normal rate with the correct format, but every sample is
    /// zero. Measured, not guessed — a silent run and a working run produced an
    /// identical number of IO callbacks at an identical 48 kHz stereo format.
    ///
    /// Tearing the tap down and rebuilding it *within the same process* does
    /// not help: the in-process retry failed on every occasion it fired. The
    /// failure is correlated with the process instance, so the effective
    /// mitigation is relaunching the helper, which the supervising CLI does.
    /// Root cause is not yet identified — see SPIKE.md.
    ///
    /// Note this cannot distinguish "the tap is broken" from "the target app is
    /// genuinely quiet"; both look like silence. The caller reports it as a
    /// state rather than an error for that reason.
    func startVerified(
        processObjectIDs: [AudioObjectID],
        meter: LevelMeter,
        settle: Duration = .milliseconds(1200)
    ) async throws -> Bool {
        try start(processObjectIDs: processObjectIDs)
        try? await Task.sleep(for: settle)
        return meter.drain().peak > 0
    }

    func stop() {
        if let streamListener, monitoredStream != kAudioObjectUnknown {
            var addr = caAddress(kAudioStreamPropertyVirtualFormat)
            AudioObjectRemovePropertyListenerBlock(
                monitoredStream, &addr, DispatchQueue.global(), streamListener)
            self.streamListener = nil
            monitoredStream = AudioObjectID(kAudioObjectUnknown)
        }
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
