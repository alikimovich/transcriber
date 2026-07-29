import { describe, expect, test } from 'bun:test'
import { parseEvent, statusChannel } from '../src/types.ts'
import { T0 } from './helpers.ts'

describe('parseEvent', () => {
  test('parses every event the helper emits', () => {
    const lines = [
      `{"type":"ready","t":${T0},"sampleRate":48000,"channels":["them","me"],"locale":"en-US"}`,
      `{"type":"transcript","t":${T0},"channel":"them","text":"hi","start":0,"end":4.02,"isFinal":true}`,
      `{"type":"level","t":${T0},"channel":"me","rms":0.1,"peak":0.6}`,
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
    const line = `{"type":"level","t":${T0},"channel":"me","rms":0.1,"peak":0.6,"clipping":true}`

    expect(parseEvent(line)).toEqual({
      type: 'level',
      t: T0,
      channel: 'me',
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
      parseEvent(`{"type":"transcript","t":${T0},"channel":"me","text":"hi","start":0}`)
    ).toBeNull()
    // Wrong type for a field.
    expect(
      parseEvent(
        `{"type":"transcript","t":${T0},"channel":"me","text":"hi","start":0,"end":1,"isFinal":"yes"}`
      )
    ).toBeNull()
  })
})

describe('statusChannel', () => {
  test('maps codes to the channel they describe', () => {
    expect(statusChannel('mic_permission_denied')).toBe('me')
    expect(statusChannel('system_audio_silent')).toBe('them')
    expect(statusChannel('system_audio_dead')).toBe('them')
    expect(statusChannel('target_process_gone')).toBe('them')
    expect(statusChannel('model_downloading')).toBeNull()
    expect(statusChannel('model_unavailable')).toBeNull()
    expect(statusChannel('capture_error')).toBeNull()
  })
})
