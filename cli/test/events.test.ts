import { describe, expect, test } from 'bun:test'
import {
  type Interpretation,
  interpretationSchema,
  parseEvent,
  statusChannel
} from '../src/types.ts'
import { T0 } from './helpers.ts'

describe('parseEvent', () => {
  test('parses every event the helper emits', () => {
    const lines = [
      `{"type":"ready","t":${T0},"sampleRate":48000,"channels":["interviewer","candidate"],"locale":"en-US"}`,
      `{"type":"transcript","t":${T0},"channel":"interviewer","text":"hi","start":0,"end":4.02,"isFinal":true}`,
      `{"type":"level","t":${T0},"channel":"candidate","rms":0.1,"peak":0.6}`,
      `{"type":"status","t":${T0},"code":"system_audio_silent","message":"no audio"}`,
      `{"type":"stopped","t":${T0},"reason":"signal"}`
    ]

    const parsed = lines.map(parseEvent)

    expect(parsed.map((event) => event?.type)).toEqual([
      'ready',
      'transcript',
      'level',
      'status',
      'stopped'
    ])
  })

  test('tolerates surrounding whitespace and rejects blank lines', () => {
    const line = `  {"type":"stopped","t":${T0},"reason":"duration"}\n`
    expect(parseEvent(line)?.type).toBe('stopped')
    expect(parseEvent('')).toBeNull()
    expect(parseEvent('   \n')).toBeNull()
  })

  test('ignores unknown fields so a newer helper stays readable', () => {
    const line = `{"type":"level","t":${T0},"channel":"candidate","rms":0.1,"peak":0.6,"clipping":true}`

    expect(parseEvent(line)).toEqual({
      type: 'level',
      t: T0,
      channel: 'candidate',
      rms: 0.1,
      peak: 0.6
    })
  })

  test('rejects malformed input instead of throwing', () => {
    expect(parseEvent('not json at all')).toBeNull()
    expect(parseEvent('{"type":"transcript"')).toBeNull()
    expect(parseEvent('null')).toBeNull()
    expect(parseEvent('[1,2,3]')).toBeNull()
    // Unknown event type.
    expect(parseEvent(`{"type":"heartbeat","t":${T0}}`)).toBeNull()
    // Unknown channel.
    expect(
      parseEvent(`{"type":"level","t":${T0},"channel":"moderator","rms":0,"peak":0}`)
    ).toBeNull()
    // Missing required field.
    expect(
      parseEvent(`{"type":"transcript","t":${T0},"channel":"candidate","text":"hi","start":0}`)
    ).toBeNull()
    // Wrong type for a field.
    expect(
      parseEvent(
        `{"type":"transcript","t":${T0},"channel":"candidate","text":"hi","start":0,"end":1,"isFinal":"yes"}`
      )
    ).toBeNull()
  })
})

describe('statusChannel', () => {
  test('maps codes to the channel they describe', () => {
    expect(statusChannel('mic_permission_denied')).toBe('candidate')
    expect(statusChannel('system_audio_silent')).toBe('interviewer')
    expect(statusChannel('system_audio_dead')).toBe('interviewer')
    expect(statusChannel('target_process_gone')).toBe('interviewer')
    expect(statusChannel('model_downloading')).toBeNull()
    expect(statusChannel('model_unavailable')).toBeNull()
    expect(statusChannel('capture_error')).toBeNull()
  })
})

describe('interpretationSchema', () => {
  const valid: Interpretation = {
    intent: 'Probing for ownership of a system under real constraints',
    emphasis: 'Scope you personally held and the trade-off you chose',
    clarification: null,
    confidence: 'medium'
  } as const

  test('accepts a valid interpretation', () => {
    const result = interpretationSchema.safeParse(valid)
    expect(result.success).toBe(true)
    expect(result.data).toEqual(valid)
  })

  test('accepts a string clarification', () => {
    const result = interpretationSchema.safeParse({ ...valid, clarification: 'Which system?' })
    expect(result.success).toBe(true)
  })

  test('rejects a missing field', () => {
    const { emphasis: _omitted, ...withoutEmphasis } = valid
    expect(interpretationSchema.safeParse(withoutEmphasis).success).toBe(false)
  })

  test('rejects a confidence value outside the enum', () => {
    expect(interpretationSchema.safeParse({ ...valid, confidence: 'very high' }).success).toBe(
      false
    )
    expect(interpretationSchema.safeParse({ ...valid, confidence: 'HIGH' }).success).toBe(false)
    expect(interpretationSchema.safeParse({ ...valid, confidence: null }).success).toBe(false)
  })

  test('rejects an absent clarification even though null is allowed', () => {
    const { clarification: _omitted, ...withoutClarification } = valid
    expect(interpretationSchema.safeParse(withoutClarification).success).toBe(false)
    expect(interpretationSchema.safeParse({ ...valid, clarification: null }).success).toBe(true)
  })

  test('rejects a wrong type in place of a string', () => {
    expect(interpretationSchema.safeParse({ ...valid, intent: 42 }).success).toBe(false)
  })
})
