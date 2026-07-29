// The wire protocol between the capture helper and the CLI.
//
// One JSON object per line on stdout. Everything human-facing goes to stderr so
// stdout stays machine-readable and pipeable (`ilcapture | jq`).

import Foundation

enum Channel: String, Codable {
    /// Microphone — me.
    case me
    /// System audio — them (the meeting and any other remote participants).
    case them
}

/// Events emitted on stdout, one JSON object per line.
enum Event: Encodable {
    /// Capture is live and both channels are producing audio.
    case ready(sampleRate: Double, channels: [Channel], locale: String)
    /// A transcription result. Volatile results are replaced by later ones
    /// covering the same span; finalized results never change.
    case transcript(
        channel: Channel, text: String, start: Double, end: Double, isFinal: Bool)
    /// Periodic per-channel audio level, so the UI can show a meter and detect
    /// a dead or silent stream without guessing.
    case level(channel: Channel, rms: Double, peak: Double)
    /// A recoverable problem the user needs to know about.
    case status(code: StatusCode, message: String)
    /// Capture stopped.
    case stopped(reason: String)

    enum StatusCode: String, Encodable {
        case micPermissionDenied = "mic_permission_denied"
        case systemAudioSilent = "system_audio_silent"
        case systemAudioDead = "system_audio_dead"
        case modelDownloading = "model_downloading"
        case modelUnavailable = "model_unavailable"
        case targetProcessGone = "target_process_gone"
        case captureError = "capture_error"
    }

    private enum CodingKeys: String, CodingKey {
        case type, channel, text, start, end, isFinal, rms, peak, code, message
        case sampleRate, channels, locale, reason, t
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Date().timeIntervalSince1970, forKey: .t)
        switch self {
        case let .ready(sampleRate, channels, locale):
            try c.encode("ready", forKey: .type)
            try c.encode(sampleRate, forKey: .sampleRate)
            try c.encode(channels, forKey: .channels)
            try c.encode(locale, forKey: .locale)
        case let .transcript(channel, text, start, end, isFinal):
            try c.encode("transcript", forKey: .type)
            try c.encode(channel, forKey: .channel)
            try c.encode(text, forKey: .text)
            try c.encode(start, forKey: .start)
            try c.encode(end, forKey: .end)
            try c.encode(isFinal, forKey: .isFinal)
        case let .level(channel, rms, peak):
            try c.encode("level", forKey: .type)
            try c.encode(channel, forKey: .channel)
            try c.encode(rms, forKey: .rms)
            try c.encode(peak, forKey: .peak)
        case let .status(code, message):
            try c.encode("status", forKey: .type)
            try c.encode(code, forKey: .code)
            try c.encode(message, forKey: .message)
        case let .stopped(reason):
            try c.encode("stopped", forKey: .type)
            try c.encode(reason, forKey: .reason)
        }
    }
}

/// Serializes events to stdout. Line-buffered and flushed per event so a
/// consumer reading the pipe sees results immediately.
struct EventWriter {
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()
    private let stdout = FileHandle.standardOutput

    func emit(_ event: Event) {
        guard var data = try? encoder.encode(event) else { return }
        data.append(0x0A)  // newline
        stdout.write(data)
    }
}

/// Human-facing diagnostics. Never mixed into stdout.
func note(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
}
