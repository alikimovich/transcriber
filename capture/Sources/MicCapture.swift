// Microphone capture — the me channel.
//
// Note on channel separation: without headphones the other participant's voice
// leaks from the speakers into this microphone, so the same speech lands on both
// channels. When the default output is the built-in speakers, Apple's
// voice-processing unit is enabled on the input node — its echo canceller knows
// what the system is sending to the speakers and subtracts it from the mic.
// With any other output (headphones, external interface) the raw mic is
// captured untouched, because voice processing also brings noise suppression
// and AGC that color the signal for no benefit there.

import AVFoundation
import Foundation

final class MicCapture {
    enum MicError: Error, CustomStringConvertible {
        case permissionDenied
        case engineFailed(String)

        var description: String {
            switch self {
            case .permissionDenied:
                return "microphone access was denied"
            case .engineFailed(let m):
                return "audio engine failed to start: \(m)"
            }
        }
    }

    private let engine = AVAudioEngine()
    private let onBuffer: (AVAudioPCMBuffer) -> Void
    private(set) var format: AVAudioFormat?

    init(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) {
        self.onBuffer = onBuffer
    }

    deinit { stop() }

    enum Access {
        case granted
        case denied
        /// Never asked. The capture path deliberately does not prompt — a
        /// headless helper that blocks on a modal dialog is indistinguishable
        /// from a hang. `ilcapture request-mic` does the asking.
        case notDetermined
    }

    /// Non-blocking. Never shows a dialog.
    static func currentAccess() -> Access {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    /// True when the default output device is built into the machine — the one
    /// case where speaker output physically reaches the microphone. Gates echo
    /// cancellation so headphone sessions keep the unprocessed mic signal.
    /// Decided once at start; someone yanking headphones mid-session keeps the
    /// raw mic (and its echo) until the next recording.
    private static func outputIsBuiltIn() -> Bool {
        guard
            let deviceID = caRead(
                AudioObjectID(kAudioObjectSystemObject),
                caAddress(kAudioHardwarePropertyDefaultOutputDevice),
                AudioObjectID.self)
        else { return false }
        return caRead(deviceID, caAddress(kAudioDevicePropertyTransportType), UInt32.self)
            == kAudioDeviceTransportTypeBuiltIn
    }

    /// Shows the system prompt and waits for an answer. Only ever called from
    /// the explicit `request-mic` command, never during capture.
    static func promptForAccess() async -> Access {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined else {
            return currentAccess()
        }
        return await AVCaptureDevice.requestAccess(for: .audio) ? .granted : .denied
    }

    func start() throws {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            throw MicError.permissionDenied
        }

        let input = engine.inputNode

        // Refuse to tap at all when there is no real hardware behind the
        // node. With no usable input device, `outputFormat(forBus:)` still
        // reports a plausible-looking 44.1 kHz format — and installing a tap
        // with it raises an uncatchable NSException ("format mismatch") that
        // kills the whole helper. `inputFormat(forBus:)` reports 0 Hz in that
        // state, which is detectable. Found by running with a mic-less
        // default input. Checked before touching voice processing so the
        // no-device path stays a plain thrown error.
        guard input.inputFormat(forBus: 0).sampleRate > 0,
            input.inputFormat(forBus: 0).channelCount > 0
        else {
            throw MicError.engineFailed(
                "no usable input device (hardware reports "
                    + "\(Int(input.inputFormat(forBus: 0).sampleRate)) Hz)")
        }

        // Echo cancellation, only when playback is on the built-in speakers.
        // A failure here degrades to the raw mic — an echoey me channel beats
        // no me channel.
        if Self.outputIsBuiltIn() {
            do {
                try input.setVoiceProcessingEnabled(true)
                // Voice processing ducks other system audio by default, and
                // "other audio" here is the very call the tap is recording —
                // keep ducking at its minimum.
                input.voiceProcessingOtherAudioDuckingConfiguration = .init(
                    enableAdvancedDucking: false, duckingLevel: .min)
                note("echo cancellation: on (output is built-in speakers)")
            } catch {
                note("echo cancellation unavailable (\(error)); using raw microphone")
            }
        } else {
            note("echo cancellation: off (output is not the built-in speakers)")
        }

        // Tap at the format the input node reports *after* the voice-processing
        // decision — enabling it swaps the underlying audio unit and changes
        // the delivered format (typically to mono).
        let hwFormat = input.inputFormat(forBus: 0)
        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
            throw MicError.engineFailed(
                "input format collapsed after enabling voice processing")
        }
        format = hwFormat

        // Name the device in the diagnostics: a mic that is "granted" and
        // "running" can still deliver pure zeros when the default input is a
        // virtual device, a mic-less display, or a Bluetooth headset whose
        // input side never engaged. The device name is the first clue.
        if let deviceID = caRead(
            AudioObjectID(kAudioObjectSystemObject),
            caAddress(kAudioHardwarePropertyDefaultInputDevice),
            AudioObjectID.self)
        {
            let name = caReadString(deviceID, kAudioObjectPropertyName) ?? "unknown"
            note(
                "microphone: \(name), \(Int(hwFormat.sampleRate)) Hz, "
                    + "\(hwFormat.channelCount) ch")
        }

        let handler = onBuffer
        input.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { buffer, _ in
            handler(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            throw MicError.engineFailed(error.localizedDescription)
        }
    }

    func stop() {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
    }
}
