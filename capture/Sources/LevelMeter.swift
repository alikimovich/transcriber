// Per-channel level tracking.
//
// This exists to make the difference between "no audio arriving", "audio
// arriving but silent", and "working" observable. Those three states are
// otherwise indistinguishable, and the silent one is what a missing
// system-audio permission looks like.

import AVFoundation
import Foundation
import os

final class LevelMeter: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: State())

    private struct State {
        var peak: Float = 0
        var sumSquares: Double = 0
        var sampleCount: Int = 0
        var callbackCount: Int = 0
    }

    /// Called from a realtime audio thread.
    func accumulate(_ buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frames > 0, channelCount > 0 else { return }

        var peak: Float = 0
        var sumSquares: Double = 0
        for c in 0..<channelCount {
            let samples = channels[c]
            for i in 0..<frames {
                let v = samples[i]
                let magnitude = abs(v)
                if magnitude > peak { peak = magnitude }
                sumSquares += Double(v) * Double(v)
            }
        }

        // Bind to immutable values: capturing the mutable accumulators directly
        // is an error under the Swift 6 language mode.
        let framePeak = peak
        let frameSumSquares = sumSquares
        let frameSamples = frames * channelCount
        lock.withLock { state in
            if framePeak > state.peak { state.peak = framePeak }
            state.sumSquares += frameSumSquares
            state.sampleCount += frameSamples
            state.callbackCount += 1
        }
    }

    struct Reading {
        let rms: Double
        let peak: Double
        let callbacks: Int
        let samples: Int

        /// No callbacks at all. Normal when the tapped process is silent;
        /// also what a broken aggregate device looks like.
        var isDead: Bool { callbacks == 0 }
        /// Callbacks arrived but every sample was zero — the signature of a
        /// missing system-audio grant.
        var isSilent: Bool { callbacks > 0 && peak == 0 }
    }

    /// Reads and resets the accumulator.
    func drain() -> Reading {
        lock.withLock { state in
            let rms = state.sampleCount > 0
                ? (state.sumSquares / Double(state.sampleCount)).squareRoot()
                : 0
            let reading = Reading(
                rms: rms,
                peak: Double(state.peak),
                callbacks: state.callbackCount,
                samples: state.sampleCount)
            state = State()
            return reading
        }
    }
}
