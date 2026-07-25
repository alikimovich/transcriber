/**
 * Wire types for the `ilcapture` helper plus the shapes the interpretation layer
 * produces. Mirrors `capture/Sources/Protocol.swift` — keep the two in sync.
 *
 * The helper writes one JSON object per line on stdout. Every event carries `t`,
 * a wall-clock epoch time in seconds (a float) stamped at emit time.
 */

import { z } from 'zod'

/** `interviewer` is system audio; `candidate` is the microphone. */
export type Channel = 'interviewer' | 'candidate'

export const CHANNELS: readonly Channel[] = ['interviewer', 'candidate']

export type StatusCode =
  | 'mic_permission_denied'
  | 'system_audio_silent'
  | 'system_audio_dead'
  | 'model_downloading'
  | 'model_unavailable'
  | 'target_process_gone'
  | 'capture_error'

export type ReadyEvent = {
  type: 'ready'
  t: number
  sampleRate: number
  channels: Channel[]
  locale: string
}

/**
 * A transcription result.
 *
 * `start`/`end` are seconds on the *analyzer's* audio timeline for that channel,
 * not epoch seconds, and each channel has its own timeline. Volatile results
 * (`isFinal: false`) are superseded by later results covering the same span and
 * are not guaranteed to be reissued as final. Finalized results never change and
 * are identified by their `start`.
 */
export type TranscriptEvent = {
  type: 'transcript'
  t: number
  channel: Channel
  text: string
  start: number
  end: number
  isFinal: boolean
}

export type LevelEvent = {
  type: 'level'
  t: number
  channel: Channel
  rms: number
  peak: number
}

export type StatusEvent = {
  type: 'status'
  t: number
  code: StatusCode
  message: string
}

export type StoppedEvent = {
  type: 'stopped'
  t: number
  reason: 'signal' | 'duration'
}

export type CaptureEvent = ReadyEvent | TranscriptEvent | LevelEvent | StatusEvent | StoppedEvent

/**
 * A channel-labelled span of speech. Timestamps are epoch seconds, projected
 * from the per-channel audio timeline onto the wall clock so that turns from the
 * two channels can be interleaved — see `TranscriptStore`.
 */
export type Turn = {
  channel: Channel
  text: string
  startedAt: number
  endedAt: number
  /** False when any part of the turn is still volatile (the speaker is mid-sentence). */
  isFinal: boolean
}

/** What the model is asked to produce for the candidate. */
export type Interpretation = {
  intent: string
  emphasis: string
  /**
   * A question to ask the interviewer back, or `null` when none is warranted.
   * Nullable rather than optional: the Responses API's strict structured output
   * requires every property to be present.
   */
  clarification: string | null
  confidence: 'low' | 'medium' | 'high'
}

/** The only state Interview Lens persists to disk. */
export type SetupContext = {
  jobDescription: string
  notes: string
  interviewerRole?: string
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

export const channelSchema = z.enum(['interviewer', 'candidate'])

export const statusCodeSchema = z.enum([
  'mic_permission_denied',
  'system_audio_silent',
  'system_audio_dead',
  'model_downloading',
  'model_unavailable',
  'target_process_gone',
  'capture_error'
])

/**
 * Deliberately non-strict: unknown keys are ignored so a newer helper that adds
 * a field does not break an older CLI.
 */
export const captureEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    t: z.number(),
    sampleRate: z.number(),
    channels: z.array(channelSchema),
    locale: z.string()
  }),
  z.object({
    type: z.literal('transcript'),
    t: z.number(),
    channel: channelSchema,
    text: z.string(),
    start: z.number(),
    end: z.number(),
    isFinal: z.boolean()
  }),
  z.object({
    type: z.literal('level'),
    t: z.number(),
    channel: channelSchema,
    rms: z.number(),
    peak: z.number()
  }),
  z.object({
    type: z.literal('status'),
    t: z.number(),
    code: statusCodeSchema,
    message: z.string()
  }),
  z.object({
    type: z.literal('stopped'),
    t: z.number(),
    reason: z.enum(['signal', 'duration'])
  })
]) satisfies z.ZodType<CaptureEvent>

export const interpretationSchema = z.object({
  intent: z.string(),
  emphasis: z.string(),
  // `.nullable()` and not `.nullish()`: an absent key is a schema violation.
  clarification: z.string().nullable(),
  confidence: z.enum(['low', 'medium', 'high'])
}) satisfies z.ZodType<Interpretation>

export const setupContextSchema = z.object({
  jobDescription: z.string(),
  notes: z.string(),
  interviewerRole: z.string().optional()
}) satisfies z.ZodType<SetupContext>

/**
 * Parse one JSONL line from the helper. Returns `null` for blank lines, invalid
 * JSON, and events that do not match the protocol — a malformed line should
 * never take the session down.
 */
export function parseEvent(line: string): CaptureEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  const parsed = captureEventSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Which channel a status code describes, or `null` when it concerns the session
 * as a whole. The helper's status events carry no channel, but the UI wants to
 * badge the affected meter.
 */
export function statusChannel(code: StatusCode): Channel | null {
  switch (code) {
    case 'mic_permission_denied':
      return 'candidate'
    case 'system_audio_silent':
    case 'system_audio_dead':
    case 'target_process_gone':
      return 'interviewer'
    case 'model_downloading':
    case 'model_unavailable':
    case 'capture_error':
      return null
  }
}
