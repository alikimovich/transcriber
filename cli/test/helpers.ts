/**
 * Shared builders. Not a `*.test.ts`, so `bun test` does not try to run it.
 *
 * The convention throughout the transcript tests: audio time zero on both
 * channels corresponds to epoch `T0`, and a result about audio ending at `end`
 * is emitted at `T0 + end + latency`. With the default zero latency, a segment
 * spanning audio `[a, b]` projects to exactly `[T0 + a, T0 + b]`, which keeps the
 * expected values readable.
 */

import type {
  Channel,
  LevelEvent,
  ReadyEvent,
  StatusCode,
  StatusEvent,
  StoppedEvent,
  TranscriptEvent
} from '../src/types.ts'

/** An arbitrary but fixed epoch second, so no test depends on the wall clock. */
export const T0 = 1_700_000_000

export type SpeakOptions = {
  /** Seconds between the audio ending and the result being emitted. */
  latency?: number
  /** Overrides the emit time outright. */
  t?: number
}

export function transcript(
  channel: Channel,
  text: string,
  start: number,
  end: number,
  isFinal: boolean,
  options: SpeakOptions = {}
): TranscriptEvent {
  return {
    type: 'transcript',
    t: options.t ?? T0 + end + (options.latency ?? 0),
    channel,
    text,
    start,
    end,
    isFinal
  }
}

export function final(
  channel: Channel,
  text: string,
  start: number,
  end: number,
  options: SpeakOptions = {}
): TranscriptEvent {
  return transcript(channel, text, start, end, true, options)
}

export function volatile(
  channel: Channel,
  text: string,
  start: number,
  end: number,
  options: SpeakOptions = {}
): TranscriptEvent {
  return transcript(channel, text, start, end, false, options)
}

export function ready(at = T0, channels: Channel[] = ['interviewer', 'candidate']): ReadyEvent {
  return { type: 'ready', t: at, sampleRate: 48000, channels, locale: 'en-US' }
}

export function level(channel: Channel, rms: number, peak: number, at = T0): LevelEvent {
  return { type: 'level', t: at, channel, rms, peak }
}

export function status(code: StatusCode, message = 'something happened', at = T0): StatusEvent {
  return { type: 'status', t: at, code, message }
}

export function stopped(reason: 'signal' | 'duration' = 'signal', at = T0): StoppedEvent {
  return { type: 'stopped', t: at, reason }
}

/** `[channel, text]` pairs, which is what most assertions actually care about. */
export function pairs(turns: { channel: Channel; text: string }[]): [Channel, string][] {
  return turns.map((turn) => [turn.channel, turn.text])
}
