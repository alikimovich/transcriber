// Microphone capture — the me channel.
//
// Note on channel separation: without headphones the other participant's voice
// leaks from the speakers into this microphone, so the same speech lands on both
// channels. The CLI warns about this; the honest fix is headphones.

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

        // Tap at the *hardware* input format, and refuse to tap at all when
        // there is no real hardware behind the node. With no usable input
        // device, `outputFormat(forBus:)` still reports a plausible-looking
        // 44.1 kHz format — and installing a tap with it raises an
        // uncatchable NSException ("format mismatch") that kills the whole
        // helper. `inputFormat(forBus:)` reports 0 Hz in that state, which is
        // detectable. Found by running with a mic-less default input.
        let hwFormat = input.inputFormat(forBus: 0)
        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
            throw MicError.engineFailed(
                "no usable input device (hardware reports \(Int(hwFormat.sampleRate)) Hz)")
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
