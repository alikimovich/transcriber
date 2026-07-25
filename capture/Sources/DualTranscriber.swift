// On-device transcription, one independent analyzer per channel.
//
// Speaker identity comes from the audio source, not from diarization: whatever
// arrives on the system-audio tap is the interviewer, whatever arrives on the
// microphone is the candidate. That is far more reliable than asking a model to
// tell voices apart — but it does assume headphones, or the interviewer's voice
// leaks from the speakers into the microphone and lands on both channels.

import AVFoundation
import Foundation
import Speech

/// One channel's analyzer pipeline.
private final class ChannelTranscriber: @unchecked Sendable {
    let channel: Channel
    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    private let analyzerFormat: AVAudioFormat
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var converter: AVAudioConverter?
    private var converterSourceFormat: AVAudioFormat?
    private var resultsTask: Task<Void, Never>?

    init(channel: Channel, locale: Locale, writer: EventWriter) async throws {
        self.channel = channel

        // Progressive gives volatile (partial) results for a live view;
        // time-indexed gives per-result audio time ranges.
        transcriber = SpeechTranscriber(
            locale: locale, preset: .timeIndexedProgressiveTranscription)

        guard
            let format = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [transcriber])
        else {
            throw TranscriberError.noCompatibleFormat
        }
        analyzerFormat = format

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.continuation = continuation

        analyzer = SpeechAnalyzer(modules: [transcriber])

        // Consume results for as long as the analyzer runs.
        let ch = channel
        resultsTask = Task { [transcriber] in
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    guard !text.isEmpty else { continue }
                    writer.emit(
                        .transcript(
                            channel: ch,
                            text: text,
                            start: result.range.start.seconds,
                            end: result.range.end.seconds,
                            isFinal: result.isFinal))
                }
            } catch {
                writer.emit(
                    .status(
                        code: .captureError,
                        message: "transcription stream for \(ch.rawValue) ended: \(error)"))
            }
        }

        try await analyzer.start(inputSequence: stream)
    }

    /// Called from a realtime audio thread. The incoming buffer wraps memory
    /// owned by Core Audio and is only valid for this call, so conversion (which
    /// copies) has to happen here rather than downstream.
    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let converted = convert(buffer) else { return }
        continuation.yield(AnalyzerInput(buffer: converted))
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let sourceFormat = buffer.format
        if sourceFormat == analyzerFormat { return buffer.copy() as? AVAudioPCMBuffer }

        // Rebuild the converter if the input format changed (e.g. the user
        // switched to AirPods mid-session).
        if converter == nil || converterSourceFormat != sourceFormat {
            converter = AVAudioConverter(from: sourceFormat, to: analyzerFormat)
            converterSourceFormat = sourceFormat
        }
        guard let converter else { return nil }

        let ratio = analyzerFormat.sampleRate / sourceFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard
            let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity)
        else { return nil }

        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return buffer
        }

        guard status != .error, output.frameLength > 0 else { return nil }
        return output
    }

    func finish() async {
        continuation.finish()
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        resultsTask?.cancel()
    }
}

enum TranscriberError: Error, CustomStringConvertible {
    case noCompatibleFormat
    case modelUnavailable(String)

    var description: String {
        switch self {
        case .noCompatibleFormat:
            return "no audio format compatible with the speech transcriber"
        case .modelUnavailable(let locale):
            return "no on-device speech model available for \(locale)"
        }
    }
}

/// Owns one analyzer pipeline per channel.
final class DualTranscriber: @unchecked Sendable {
    private var channels: [Channel: ChannelTranscriber] = [:]

    init(locale localeID: String, writer: EventWriter) async throws {
        let locale = Locale(identifier: localeID)

        // Make sure the on-device model is present before starting, and report
        // the download rather than appearing to hang on first run.
        let probe = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
        let assetStatus = await AssetInventory.status(forModules: [probe])
        if assetStatus != .installed {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
                writer.emit(
                    .status(
                        code: .modelDownloading,
                        message: "downloading the on-device speech model for \(localeID)…"))
                try await request.downloadAndInstall()
            }
        }

        // Reserving the locale keeps its model resident. The cap is small
        // (typically 5), so release on the way out.
        _ = try? await AssetInventory.reserve(locale: locale)

        for channel in [Channel.interviewer, Channel.candidate] {
            channels[channel] = try await ChannelTranscriber(
                channel: channel, locale: locale, writer: writer)
        }
    }

    /// Called from realtime audio threads.
    func feed(_ buffer: AVAudioPCMBuffer, into channel: Channel) {
        channels[channel]?.feed(buffer)
    }

    func finish() async {
        for transcriber in channels.values {
            await transcriber.finish()
        }
        channels.removeAll()
    }
}
