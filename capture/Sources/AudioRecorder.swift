// Compressed stereo recording of the whole conversation.
//
// One file, two channels: left = me (microphone), right = them (system audio).
// The two sources arrive on independent realtime callbacks, at possibly
// different formats and sample rates, and asynchronously — so they can't just
// be interleaved as they land. Instead each is converted to a canonical
// 48 kHz mono Float32 stream and pushed into a per-channel FIFO. A writer on a
// dedicated serial queue drains both FIFOs paced by the wall clock, zero-filling
// whichever channel is short. That keeps the mic=L / system=R mapping stable no
// matter which channels are actually live: a muted or absent mic is just silence
// on the left, an absent system tap is silence on the right, and the timeline of
// the two never drifts apart.
//
// The output is AAC (~128 kbps). This is deliberately lossy — the point is a
// small, tool-friendly log of the meeting, not an archival master.

import AVFoundation
import Foundation

/// A thread-safe FIFO of Float32 samples. Written from a realtime audio thread,
/// drained from the writer queue. Mirrors LevelMeter's OSAllocatedUnfairLock
/// accumulation pattern.
final class SampleFIFO: @unchecked Sendable {
    // NSLock (rather than OSAllocatedUnfairLock) because the critical sections
    // move raw sample pointers, which don't belong inside a @Sendable withLock
    // closure. Same guard-under-a-lock shape LevelMeter uses.
    private let lock = NSLock()
    private var samples: [Float] = []

    // Safety cap: if the writer ever stalls, cap the backlog rather than growing
    // without bound. In steady state the backlog is only a few hundred ms because
    // audio is produced and consumed at the same realtime rate.
    private let maxSamples = Int(48_000 * 10)

    init() { samples.reserveCapacity(48_000) }

    /// Called from a realtime audio thread.
    func write(_ ptr: UnsafePointer<Float>, count: Int) {
        guard count > 0 else { return }
        lock.lock()
        samples.append(contentsOf: UnsafeBufferPointer(start: ptr, count: count))
        if samples.count > maxSamples {
            samples.removeFirst(samples.count - maxSamples)
        }
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return samples.count
    }

    /// Pops up to `count` samples into `dest`, returning how many were copied.
    /// The caller is responsible for zero-filling the remainder of `dest`.
    func read(into dest: UnsafeMutablePointer<Float>, count: Int) -> Int {
        lock.lock()
        defer { lock.unlock() }
        let n = min(count, samples.count)
        guard n > 0 else { return 0 }
        samples.withUnsafeBufferPointer { dest.update(from: $0.baseAddress!, count: n) }
        samples.removeFirst(n)
        return n
    }
}

/// Converts a channel's incoming buffers to a canonical 48 kHz mono Float32
/// format, rebuilding the converter when the source format changes (e.g. the
/// user switches to AirPods mid-session). Used from a single audio thread per
/// channel, so it needs no internal locking.
private final class ChannelConverter: @unchecked Sendable {
    private let target: AVAudioFormat
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?

    init(target: AVAudioFormat) { self.target = target }

    /// Returns a mono 48 kHz Float32 buffer (channelData[0]) or nil.
    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let source = buffer.format
        if source == target { return buffer.copy() as? AVAudioPCMBuffer }

        if converter == nil || sourceFormat != source {
            converter = AVAudioConverter(from: source, to: target)
            // Without this the converter primes with silence, which shifts every
            // timestamp downstream (CLAUDE.md).
            converter?.primeMethod = .none
            sourceFormat = source
        }
        guard let converter else { return nil }

        let ratio = target.sampleRate / source.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            return nil
        }

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
}

/// Records the mic and system channels into one stereo AAC .m4a.
final class AudioRecorder: @unchecked Sendable {
    private static let sampleRate: Double = 48_000

    private let writer: EventWriter
    private let outputFormat: AVAudioFormat  // the file's PCM processing format
    private let meConverter: ChannelConverter
    private let themConverter: ChannelConverter
    private let meFIFO = SampleFIFO()
    private let themFIFO = SampleFIFO()
    private let queue = DispatchQueue(label: "com.alikimovich.transcriber.recorder")

    // The recording clock starts at the first sample fed on *either* channel,
    // not at init: tap setup blocks for several seconds, and anchoring here
    // would prepend that as leading silence and inflate the file. Both channels
    // share this one t0, so their alignment is preserved and a channel that
    // starts late simply gets leading silence relative to it. Written from an
    // audio thread, read from the writer queue — hence its own lock.
    private let clockLock = NSLock()
    private var startTime: DispatchTime?

    // All of the following are only ever touched on `queue` (drain / finish).
    private var file: AVAudioFile?
    private var timer: DispatchSourceTimer?
    private var framesWritten: Int64 = 0
    private var writeFailed = false

    // A channel that supplies some samples but persistently far fewer than the
    // wall clock demands is not silent — it is arriving slower than its declared
    // rate, which means the declared format is wrong and the recording is
    // garbled (rhythmically zero-stuffed, time-compressed speech). That exact
    // failure shipped once; make it loud. A channel supplying nothing at all is
    // fine — an absent mic is deliberately just silence on the left.
    private var meRead: Int64 = 0
    private var themRead: Int64 = 0
    private var underfillWarned = false

    /// Opens `<path>` for writing as stereo AAC. Returns nil (after emitting a
    /// captureError status) if the file can't be created — the caller then just
    /// captures without recording rather than failing the session.
    init?(path: String, writer: EventWriter) {
        // The `settings` describe the encoded file. AVAudioFile derives a
        // standard deinterleaved Float32 `processingFormat` at the same rate and
        // channel count, and encodes to AAC as PCM buffers are written to it.
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: Self.sampleRate,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 128_000,
        ]
        let url = URL(fileURLWithPath: path)

        let openedFile: AVAudioFile
        do {
            openedFile = try AVAudioFile(forWriting: url, settings: settings)
        } catch {
            writer.emit(
                .status(
                    code: .captureError,
                    message:
                        "could not open recording file at \(path): \(error.localizedDescription); continuing without recording"
                ))
            return nil
        }

        guard
            let mono = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: Self.sampleRate,
                channels: 1,
                interleaved: false)
        else {
            writer.emit(
                .status(
                    code: .captureError,
                    message: "could not build the recorder audio format; continuing without recording"))
            return nil
        }

        self.writer = writer
        self.file = openedFile
        self.outputFormat = openedFile.processingFormat
        self.meConverter = ChannelConverter(target: mono)
        self.themConverter = ChannelConverter(target: mono)

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(200), repeating: .milliseconds(200))
        t.setEventHandler { [weak self] in self?.drain(final: false) }
        self.timer = t
        t.resume()
    }

    /// Called from a realtime audio thread (one thread per channel). Converts the
    /// buffer and appends it to that channel's FIFO. Never touches the file.
    func feed(_ buffer: AVAudioPCMBuffer, into channel: Channel) {
        let converter: ChannelConverter
        let fifo: SampleFIFO
        switch channel {
        case .me:
            converter = meConverter
            fifo = meFIFO
        case .them:
            converter = themConverter
            fifo = themFIFO
        }
        guard let mono = converter.convert(buffer), let data = mono.floatChannelData else { return }
        startClockIfNeeded()
        fifo.write(data[0], count: Int(mono.frameLength))
    }

    /// Anchors the recording clock to the first sample seen on either channel.
    private func startClockIfNeeded() {
        clockLock.lock()
        if startTime == nil { startTime = DispatchTime.now() }
        clockLock.unlock()
    }

    /// Runs on `queue`. Writes enough frames to catch the file up to the wall
    /// clock, popping real samples from each FIFO and zero-filling shortfalls.
    private func drain(final isFinal: Bool) {
        guard !writeFailed, let file else { return }

        clockLock.lock()
        let start = startTime
        clockLock.unlock()
        // No audio on either channel yet: nothing to write, don't advance.
        guard let start else { return }

        let frames: Int
        if isFinal {
            // Flush whatever real audio is still buffered on either side.
            frames = max(meFIFO.count, themFIFO.count)
        } else {
            let elapsedNs = DispatchTime.now().uptimeNanoseconds &- start.uptimeNanoseconds
            let elapsed = Double(elapsedNs) / 1_000_000_000
            let target = Int64(elapsed * Self.sampleRate)
            // Cap per-tick work so a stalled timer can't force a huge allocation;
            // it simply catches up over the following ticks.
            frames = min(Int(max(0, target - framesWritten)), Int(Self.sampleRate) * 5)
        }
        guard frames > 0 else { return }

        guard
            let stereo = AVAudioPCMBuffer(
                pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(frames)),
            let channelData = stereo.floatChannelData,
            outputFormat.channelCount >= 2
        else { return }
        stereo.frameLength = AVAudioFrameCount(frames)

        // Zero-fill first, then overlay whatever real samples each FIFO has.
        // Left = me (mic), right = them (system audio).
        memset(channelData[0], 0, frames * MemoryLayout<Float>.stride)
        memset(channelData[1], 0, frames * MemoryLayout<Float>.stride)
        meRead += Int64(meFIFO.read(into: channelData[0], count: frames))
        themRead += Int64(themFIFO.read(into: channelData[1], count: frames))

        // After ~10s, a live-but-starved channel means a declared-rate mismatch
        // upstream. Warn once; keep recording what there is.
        if !underfillWarned, framesWritten > Int64(Self.sampleRate) * 10 {
            for (name, read) in [("me", meRead), ("them", themRead)] {
                let ratio = Double(read) / Double(framesWritten)
                if ratio > 0.05, ratio < 0.8 {
                    underfillWarned = true
                    writer.emit(
                        .status(
                            code: .captureError,
                            message:
                                "the \(name) channel is producing audio at \(Int(ratio * 100))% of its declared rate — the recording will be garbled; this usually means the audio device's real format differs from what the tap reports"
                        ))
                }
            }
        }

        do {
            try file.write(from: stereo)
            framesWritten += Int64(frames)
        } catch {
            writeFailed = true
            self.file = nil
            writer.emit(
                .status(
                    code: .captureError,
                    message: "recording write failed: \(error.localizedDescription); recording stopped"))
        }
    }

    /// Drains the remaining buffered samples and closes the file. Bounded and
    /// quick: the FIFOs hold at most a few hundred ms, so this completes well
    /// inside the time-capped teardown and never blocks it.
    func finish() {
        timer?.cancel()
        timer = nil
        // Flush and close on the writer queue so no drain can be mid-write.
        queue.sync {
            self.drain(final: true)
            self.file = nil  // releasing the AVAudioFile closes and finalizes it
        }
    }
}
