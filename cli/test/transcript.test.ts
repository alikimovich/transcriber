import { describe, expect, test } from 'bun:test'
import { TranscriptStore } from '../src/transcript.ts'
import { parseEvent } from '../src/types.ts'
import { final, level, pairs, ready, status, stopped, T0, transcript, volatile } from './helpers.ts'

describe('windowing', () => {
  test('keeps only turns that reach into the window', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'ancient history', 0, 2))
    store.applyEvent(final('me', 'inside the window', 8, 10))

    const turns = store.window(6, T0 + 10)

    expect(pairs(turns)).toEqual([['me', 'inside the window']])
  })

  test('includes a turn that ends exactly on the cutoff', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'on the boundary', 2, 4))

    expect(store.window(6, T0 + 10)).toHaveLength(1)
    expect(store.window(5.9, T0 + 10)).toHaveLength(0)
  })

  test('includes a long turn that started before the window but ends inside it', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'a very long preamble', 0, 55))

    const turns = store.window(30, T0 + 60)

    expect(pairs(turns)).toEqual([['them', 'a very long preamble']])
  })

  test('returns turns oldest first regardless of arrival order', () => {
    const store = new TranscriptStore()
    // A late-arriving correction for earlier audio.
    store.applyEvent(final('me', 'second', 4, 6))
    store.applyEvent(final('them', 'first', 0, 2))

    expect(pairs(store.window(60, T0 + 10))).toEqual([
      ['them', 'first'],
      ['me', 'second']
    ])
  })

  test('merges consecutive same-channel finalized segments into one turn', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'Tell me about a time', 0, 2))
    store.applyEvent(final('them', 'you disagreed with a decision.', 2, 4))
    store.applyEvent(final('me', 'Sure.', 4, 5))
    store.applyEvent(final('them', 'Take your time.', 5, 6))

    const turns = store.window(60, T0 + 10)

    expect(pairs(turns)).toEqual([
      ['them', 'Tell me about a time you disagreed with a decision.'],
      ['me', 'Sure.'],
      ['them', 'Take your time.']
    ])
    expect(turns[0]?.startedAt).toBe(T0)
    expect(turns[0]?.endedAt).toBe(T0 + 4)
    expect(turns.every((turn) => turn.isFinal)).toBe(true)
  })

  test('text from outside the window never leaks into a merged turn', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'old and out of scope', 0, 2))
    store.applyEvent(final('them', 'recent', 3, 5))

    // Filtering happens before merging, so the dropped segment cannot be pulled
    // back in by the segment it would otherwise merge with.
    expect(pairs(store.window(2.5, T0 + 5))).toEqual([['them', 'recent']])
  })

  test('a non-positive window is empty and an infinite window is everything', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'hello', 0, 1))

    expect(store.window(0, T0 + 1)).toEqual([])
    expect(store.window(-5, T0 + 1)).toEqual([])
    expect(store.window(Number.NaN, T0 + 1)).toEqual([])
    expect(store.window(Number.POSITIVE_INFINITY, T0 + 100_000)).toHaveLength(1)
  })

  test('a merged turn is not final while any part of it is still volatile', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'So,', 0, 1))
    store.applyEvent(volatile('them', 'walk me through', 1, 2))

    const turns = store.window(60, T0 + 2)

    expect(pairs(turns)).toEqual([['them', 'So, walk me through']])
    expect(turns[0]?.isFinal).toBe(false)
  })
})

describe('volatile results', () => {
  test('a volatile is replaced by the final covering the same span', () => {
    const store = new TranscriptStore()
    store.applyEvent(volatile('them', 'so tell me', 0, 2))
    store.applyEvent(volatile('them', 'so tell me about your', 0, 3))
    store.applyEvent(final('them', 'So tell me about your last role.', 0, 4))

    expect(store.render().them).toBe('So tell me about your last role.')
    expect(pairs(store.window(60, T0 + 4))).toEqual([['them', 'So tell me about your last role.']])
  })

  test('a volatile that never finalizes is still visible', () => {
    const store = new TranscriptStore()
    store.applyEvent(volatile('them', 'and what would you', 0, 2))

    const turns = store.window(60, T0 + 2)

    expect(pairs(turns)).toEqual([['them', 'and what would you']])
    expect(turns[0]?.isFinal).toBe(false)
    expect(store.render().them).toBe('and what would you')
  })

  test('a volatile abandoned mid-utterance is kept when the next one begins', () => {
    const store = new TranscriptStore()
    store.applyEvent(volatile('them', 'first question never finalized', 0, 3))
    store.applyEvent(volatile('them', 'second question', 4, 5))

    expect(store.render().them).toBe('first question never finalized second question')
    const turns = store.window(60, T0 + 5)
    expect(pairs(turns)).toEqual([['them', 'first question never finalized second question']])
    // The retired one is settled; only the live one is still in flight.
    expect(turns[0]?.isFinal).toBe(false)
  })

  test('a real final still replaces a retired volatile with the same start', () => {
    const store = new TranscriptStore()
    store.applyEvent(volatile('them', 'raw guess at the question', 0, 3))
    store.applyEvent(volatile('them', 'next utterance', 4, 5))
    store.applyEvent(final('them', 'Corrected guess at the question.', 0, 3.2))

    expect(store.render().them).toBe('Corrected guess at the question. next utterance')
  })

  test('a real final replaces a retired volatile even when the boundary moved', () => {
    const store = new TranscriptStore()
    store.applyEvent(volatile('them', 'raw guess at the question', 0, 3))
    store.applyEvent(volatile('them', 'next utterance', 4, 5))
    // The analyzer settled on a slightly different span for the same speech, so
    // the start no longer matches exactly.
    store.applyEvent(final('them', 'Corrected guess at the question.', 0.08, 3.2))

    expect(store.render().them).toBe('Corrected guess at the question. next utterance')
  })

  test('a retired volatile survives a final for the next utterance that clips it', () => {
    const store = new TranscriptStore()
    store.applyEvent(volatile('them', 'a whole abandoned question', 0, 3))
    store.applyEvent(volatile('them', 'the next one', 3.5, 4))
    // This final belongs to the following utterance and only grazes the
    // abandoned one; it must not take the abandoned question with it.
    store.applyEvent(final('them', 'The next one.', 2.9, 4.5))

    expect(store.render().them).toBe('a whole abandoned question The next one.')
  })

  test('opting out drops an abandoned volatile instead', () => {
    const store = new TranscriptStore({ keepAbandonedVolatiles: false })
    store.applyEvent(volatile('them', 'first question never finalized', 0, 3))
    store.applyEvent(volatile('them', 'second question', 4, 5))

    expect(store.render().them).toBe('second question')
  })

  test('a volatile for the next utterance survives a late final for the previous one', () => {
    const store = new TranscriptStore()
    store.applyEvent(volatile('them', 'guess', 0, 3))
    store.applyEvent(volatile('them', 'and also', 4, 5))
    // The final for 0..3.5 lands after the next utterance already started.
    store.applyEvent(final('them', 'Settled text.', 0, 3.5, { latency: 1.5 }))

    expect(store.render().them).toBe('Settled text. and also')
  })

  test('a stale volatile whose audio is already finalized is ignored', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'Settled.', 0, 4))
    store.applyEvent(volatile('them', 'settled', 0, 3))

    expect(store.render().them).toBe('Settled.')
  })

  test('empty text never enters the transcript', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'Real text.', 0, 2))
    store.applyEvent(volatile('them', '   ', 2, 3))

    expect(store.render().them).toBe('Real text.')
  })
})

describe('finalized results', () => {
  test('a reissued final replaces the one with the same start rather than appending', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('me', 'i worked on a ceche', 0, 3))
    store.applyEvent(final('me', 'I worked on a cache.', 0, 3))

    expect(store.render().me).toBe('I worked on a cache.')
  })

  test('finals arriving out of order are ordered by audio position', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('me', 'third', 4, 6))
    store.applyEvent(final('me', 'first', 0, 2))
    store.applyEvent(final('me', 'second', 2, 4))

    expect(store.render().me).toBe('first second third')
  })
})

describe('channel isolation', () => {
  test('interleaved speech never crosses channels', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'What did you own?', 0, 2))
    store.applyEvent(volatile('me', 'i owned the', 2, 3))
    store.applyEvent(final('me', 'I owned the ingest pipeline.', 2, 4))
    store.applyEvent(volatile('them', 'and how big was', 4, 5))

    const rendered = store.render()
    expect(rendered.them).toBe('What did you own? and how big was')
    expect(rendered.me).toBe('I owned the ingest pipeline.')
  })

  test('clearing one channel is not possible without clearing the other', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'question', 0, 2))
    store.applyEvent(final('me', 'answer', 2, 4))

    store.clear()

    expect(store.render()).toEqual({ them: '', me: '' })
    expect(store.window(60, T0 + 4)).toEqual([])
  })

  test('a volatile on one channel does not mark the other channel unsettled', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'question', 0, 2))
    store.applyEvent(volatile('me', 'answering now', 2, 3))

    const turns = store.window(60, T0 + 3)
    expect(turns[0]?.isFinal).toBe(true)
    expect(turns[1]?.isFinal).toBe(false)
  })
})

describe('clock alignment', () => {
  test('channels with different analyzer start times interleave correctly', () => {
    const store = new TranscriptStore()
    // The me's analyzer started two seconds later, so its audio time zero
    // is two seconds further along the wall clock.
    store.applyEvent(final('them', 'first in real time', 0, 1))
    store.applyEvent(final('me', 'second in real time', 0, 1, { t: T0 + 3 }))

    const turns = store.window(60, T0 + 4)

    expect(pairs(turns)).toEqual([
      ['them', 'first in real time'],
      ['me', 'second in real time']
    ])
    expect(turns[1]?.startedAt).toBe(T0 + 2)
  })

  test('a tighter latency estimate retroactively corrects earlier turns', () => {
    const store = new TranscriptStore()
    // The first result took three seconds to arrive, so it over-estimates the
    // offset; a later, faster result tightens it.
    store.applyEvent(final('them', 'warm up', 0, 1, { latency: 3 }))
    expect(store.window(60, T0 + 4)[0]?.startedAt).toBe(T0 + 3)

    store.applyEvent(final('them', 'steady state', 1, 2, { latency: 0 }))
    expect(store.window(60, T0 + 4)[0]?.startedAt).toBe(T0)
  })

  test('an implausible offset sample is ignored', () => {
    const store = new TranscriptStore()
    // `end` beyond the emit time cannot be true; the segment falls back to its
    // own timestamps rather than poisoning the channel offset.
    store.applyEvent(final('them', 'impossible', 0, 10, { t: 5 }))

    expect(store.window(60, T0)).toHaveLength(0)
    expect(store.render().them).toBe('impossible')
  })
})

describe('session state', () => {
  test('tracks the last level per channel', () => {
    const store = new TranscriptStore()
    store.applyEvent(level('them', 0.1, 0.6, T0))
    store.applyEvent(level('them', 0.2, 0.7, T0 + 1))
    store.applyEvent(level('me', 0, 0, T0 + 1))

    expect(store.state('them').level).toEqual({ rms: 0.2, peak: 0.7, t: T0 + 1 })
    expect(store.state('me').level).toEqual({ rms: 0, peak: 0, t: T0 + 1 })
  })

  test('attributes a status to the channel it describes', () => {
    const store = new TranscriptStore()
    store.applyEvent(status('mic_permission_denied', 'no mic'))
    store.applyEvent(status('system_audio_silent', 'silence'))

    expect(store.state('me').status?.code).toBe('mic_permission_denied')
    expect(store.state('them').status?.code).toBe('system_audio_silent')
    expect(store.lastStatus?.code).toBe('system_audio_silent')
  })

  test('a session-wide status is recorded without being blamed on a channel', () => {
    const store = new TranscriptStore()
    store.applyEvent(status('model_downloading', 'fetching model'))

    expect(store.lastStatus?.code).toBe('model_downloading')
    expect(store.state('them').status).toBeNull()
    expect(store.state('me').status).toBeNull()
  })

  test('records the ready and stopped events', () => {
    const store = new TranscriptStore()
    expect(store.session).toBeNull()

    store.applyEvent(ready())
    store.applyEvent(stopped('duration'))

    expect(store.session?.sampleRate).toBe(48000)
    expect(store.session?.channels).toEqual(['them', 'me'])
    expect(store.stoppedReason).toBe('duration')
  })

  test('a second ready starts a fresh transcript because the audio clock reset', () => {
    const store = new TranscriptStore()
    store.applyEvent(ready())
    store.applyEvent(final('them', 'previous session', 0, 2))
    store.applyEvent(stopped('signal'))

    store.applyEvent(ready(T0 + 100, ['them']))
    store.applyEvent(final('them', 'new session', 0, 2, { t: T0 + 102 }))

    expect(store.render().them).toBe('new session')
    expect(store.stoppedReason).toBeNull()
    expect(store.session?.channels).toEqual(['them'])
  })

  test('clear keeps live stream state but forgets the transcript', () => {
    const store = new TranscriptStore()
    store.applyEvent(level('me', 0.3, 0.9))
    store.applyEvent(status('mic_permission_denied', 'no mic'))
    store.applyEvent(final('me', 'text', 0, 1))

    store.clear()

    expect(store.render().me).toBe('')
    expect(store.state('me').level?.rms).toBe(0.3)
    expect(store.state('me').status?.code).toBe('mic_permission_denied')
  })

  test('level events bump the revision but not the transcript revision', () => {
    const store = new TranscriptStore()
    store.applyEvent(final('them', 'text', 0, 1))
    const revision = store.revision
    const transcriptRevision = store.transcriptRevision

    store.applyEvent(level('them', 0.1, 0.2))

    expect(store.revision).toBe(revision + 1)
    expect(store.transcriptRevision).toBe(transcriptRevision)
  })

  test('an unknown event type is ignored rather than throwing', () => {
    const store = new TranscriptStore()
    const revision = store.revision

    // Simulates a newer helper emitting an event this build predates.
    store.applyEvent({ type: 'heartbeat', t: T0 } as unknown as Parameters<
      TranscriptStore['applyEvent']
    >[0])

    expect(store.revision).toBe(revision)
  })
})

describe('a realistic exchange', () => {
  test('assembles into the turns a prompt would be built from', () => {
    const store = new TranscriptStore()
    const script = [
      volatile('them', 'so', 0, 0.5),
      volatile('them', 'so tell me about a time', 0, 1.8),
      final('them', 'So tell me about a time you shipped something risky.', 0, 3.4),
      volatile('me', 'sure', 3.6, 4.1),
      volatile('me', 'sure so last year we', 3.6, 5.2),
      final('me', 'Sure, so last year we migrated the billing system.', 3.6, 6.0),
      final('them', 'How risky?', 6.4, 7.1),
      volatile('them', 'like what could have', 7.3, 8.0)
    ]
    for (const event of script) store.applyEvent(event)

    const turns = store.window(30, T0 + 8)

    expect(pairs(turns)).toEqual([
      ['them', 'So tell me about a time you shipped something risky.'],
      ['me', 'Sure, so last year we migrated the billing system.'],
      ['them', 'How risky? like what could have']
    ])
    expect(turns.map((turn) => turn.isFinal)).toEqual([true, true, false])
    expect(store.render()).toEqual({
      them: 'So tell me about a time you shipped something risky. How risky? like what could have',
      me: 'Sure, so last year we migrated the billing system.'
    })
  })

  test('an event survives the round trip through the JSONL parser', () => {
    const store = new TranscriptStore()
    const line = JSON.stringify(transcript('them', 'Hello there.', 0, 1, true))

    const event = parseEvent(line)
    expect(event).not.toBeNull()
    if (event !== null) store.applyEvent(event)

    expect(store.render().them).toBe('Hello there.')
  })
})
