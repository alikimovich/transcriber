import { describe, expect, test } from 'bun:test'
import {
  type FetchLike,
  type InterpretOptions,
  type InterpretResult,
  interpret
} from '../src/interpret.ts'
import { openaiProvider, RESPONSES_URL } from '../src/providers/index.ts'
import { parseGoDuration, suggestedDelayMs } from '../src/retry.ts'
import type { Interpretation, SetupContext, Turn } from '../src/types.ts'
import { T0 } from './helpers.ts'

const context: SetupContext = { jobDescription: 'Backend role', notes: 'Ten years of Go' }

const turns: Turn[] = [
  {
    channel: 'interviewer',
    text: 'Why did you leave your last job?',
    startedAt: T0,
    endedAt: T0 + 3,
    isFinal: true
  }
]

const interpretation: Interpretation = {
  intent: 'Checking for accountability and how you talk about former colleagues',
  emphasis: 'A forward-looking reason tied to the work, not the people',
  clarification: null,
  confidence: 'high'
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A realistic envelope: a reasoning item comes first, so anything that reads
 * `output[0]` picks up an item with no content at all.
 */
function completedResponse(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_abc123',
    object: 'response',
    status: 'completed',
    model: 'gpt-5.6-luna',
    output: [
      { id: 'rs_1', type: 'reasoning', summary: [] },
      {
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: typeof payload === 'string' ? payload : JSON.stringify(payload),
            annotations: []
          }
        ]
      }
    ],
    usage: {
      input_tokens: 812,
      input_tokens_details: { cached_tokens: 768 },
      output_tokens: 61,
      total_tokens: 873
    },
    ...overrides
  }
}

type Step = { status?: number; body?: unknown; headers?: Record<string, string> } | Error

function mockFetch(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]
    if (step === undefined) throw new Error('mock fetch ran out of steps')
    if (step instanceof Error) throw step
    const body = typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {})
    return new Response(body, { status: step.status ?? 200, headers: step.headers })
  }
  return { fetchImpl, calls }
}

/** A fetch that only settles when it is aborted, like a hung connection. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init.signal
    if (signal == null) return
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
      once: true
    })
  })

function deterministic(overrides: InterpretOptions = {}): InterpretOptions {
  return {
    // Pinned: these exercise the OpenAI envelope and endpoint specifically.
    // The default provider is xAI.
    provider: 'openai',
    apiKey: 'sk-test',
    random: () => 0.5,
    now: () => 1_000_000,
    ...overrides
  }
}

function expectOk(result: InterpretResult) {
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`)
  return result
}

function expectError(result: InterpretResult) {
  if (result.kind !== 'error') throw new Error(`expected error, got ${JSON.stringify(result)}`)
  return result
}

// ---------------------------------------------------------------------------

describe('response parsing', () => {
  test('extracts the interpretation past a leading reasoning item', () => {
    const result = expectOk(openaiProvider.parseResponse(completedResponse(interpretation)))

    expect(result.interpretation).toEqual(interpretation)
    expect(result.responseId).toBe('resp_abc123')
    expect(result.usage).toEqual({
      inputTokens: 812,
      outputTokens: 61,
      totalTokens: 873,
      cachedInputTokens: 768
    })
  })

  test('detects a refusal even though the response reports completed', () => {
    const response = completedResponse(interpretation, {
      output: [
        { id: 'rs_1', type: 'reasoning', summary: [] },
        {
          id: 'msg_1',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'I cannot help with that.' }]
        }
      ]
    })

    const result = openaiProvider.parseResponse(response)

    expect(result.kind).toBe('refusal')
    if (result.kind === 'refusal') expect(result.message).toBe('I cannot help with that.')
  })

  test('reports an incomplete response and why it stopped', () => {
    const response = completedResponse(interpretation, {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' }
    })

    const result = openaiProvider.parseResponse(response)

    expect(result.kind).toBe('incomplete')
    if (result.kind === 'incomplete') {
      expect(result.reason).toBe('max_output_tokens')
      expect(result.message).toContain('max_output_tokens')
    }
  })

  test('reports a failed response using the error message', () => {
    const result = openaiProvider.parseResponse(
      completedResponse(interpretation, {
        status: 'failed',
        error: { code: 'server_error', message: 'the model went away' }
      })
    )

    expect(result.kind).toBe('incomplete')
    if (result.kind === 'incomplete') expect(result.reason).toBe('the model went away')
  })

  test('reports malformed JSON without throwing', () => {
    const result = openaiProvider.parseResponse(completedResponse('{"intent": "half a resp'))

    expect(result.kind).toBe('malformed')
    if (result.kind === 'malformed') {
      expect(result.message).toContain('not JSON')
      expect(result.raw).toBe('{"intent": "half a resp')
    }
  })

  test('rejects valid JSON that is not an interpretation', () => {
    const result = openaiProvider.parseResponse(
      completedResponse({ intent: 'x', emphasis: 'y', confidence: 'certain' })
    )

    expect(result.kind).toBe('malformed')
    if (result.kind === 'malformed') expect(result.message).toContain('schema')
  })

  test('rejects an interpretation missing clarification', () => {
    const { clarification: _omitted, ...withoutClarification } = interpretation

    expect(openaiProvider.parseResponse(completedResponse(withoutClarification)).kind).toBe(
      'malformed'
    )
  })

  test('concatenates multiple output_text parts', () => {
    const serialized = JSON.stringify(interpretation)
    const response = completedResponse(interpretation, {
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: serialized.slice(0, 20) },
            { type: 'output_text', text: serialized.slice(20) }
          ]
        }
      ]
    })

    expect(expectOk(openaiProvider.parseResponse(response)).interpretation).toEqual(interpretation)
  })

  test('reports responses with nothing usable in them', () => {
    expect(openaiProvider.parseResponse(null).kind).toBe('malformed')
    expect(openaiProvider.parseResponse('a string').kind).toBe('malformed')
    expect(openaiProvider.parseResponse({ status: 'completed' }).kind).toBe('malformed')
    expect(
      openaiProvider.parseResponse({ status: 'completed', output: [{ type: 'reasoning' }] }).kind
    ).toBe('malformed')
  })

  test('treats a response with no status as not completed', () => {
    expect(openaiProvider.parseResponse({ output: [] }).kind).toBe('incomplete')
  })
})

describe('go duration parsing', () => {
  test('parses the formats the rate-limit headers use', () => {
    expect(parseGoDuration('6m0s')).toBe(360_000)
    expect(parseGoDuration('1.5s')).toBe(1_500)
    expect(parseGoDuration('88ms')).toBe(88)
    expect(parseGoDuration('1h2m3s')).toBe(3_723_000)
    expect(parseGoDuration('0')).toBe(0)
    expect(parseGoDuration('500us')).toBe(0.5)
    expect(parseGoDuration('500µs')).toBe(0.5)
    expect(parseGoDuration('-1.5h')).toBe(-5_400_000)
  })

  test('is not parseInt', () => {
    // The trap this function exists for.
    expect(Number.parseInt('6m0s', 10)).toBe(6)
    expect(parseGoDuration('6m0s')).toBe(360_000)
  })

  test('rejects anything that is not a Go duration', () => {
    expect(parseGoDuration('')).toBeNull()
    expect(parseGoDuration('soon')).toBeNull()
    expect(parseGoDuration('6m0')).toBeNull()
    expect(parseGoDuration('6')).toBeNull()
    expect(parseGoDuration('6q')).toBeNull()
    expect(parseGoDuration('m6s')).toBeNull()
  })
})

describe('retry-after interpretation', () => {
  const now = Date.parse('2026-07-24T12:00:00Z')

  test('reads Retry-After in seconds', () => {
    expect(suggestedDelayMs(new Headers({ 'retry-after': '5' }), now)).toBe(5_000)
  })

  test('reads Retry-After as an HTTP date', () => {
    const headers = new Headers({ 'retry-after': 'Fri, 24 Jul 2026 12:00:30 GMT' })
    expect(suggestedDelayMs(headers, now)).toBe(30_000)
  })

  test('reads the rate-limit reset headers as Go durations', () => {
    const headers = new Headers({
      'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-reset-tokens': '1.5s'
    })
    expect(suggestedDelayMs(headers, now)).toBe(1_500)
  })

  test('returns null when the server said nothing', () => {
    expect(suggestedDelayMs(new Headers(), now)).toBeNull()
  })
})

describe('requests', () => {
  test('posts to the Responses endpoint with the right headers and body', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: completedResponse(interpretation) }])

    const result = expectOk(
      await interpret({ context, turns }, deterministic({ fetch: fetchImpl }))
    )

    expect(result.interpretation).toEqual(interpretation)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.url).toBe(RESPONSES_URL)
    expect(call?.init.method).toBe('POST')
    const headers = call?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(headers['content-type']).toBe('application/json')
    // No beta or version header on this endpoint.
    expect(Object.keys(headers).sort()).toEqual(['authorization', 'content-type'])

    const body = JSON.parse(String(call?.init.body))
    expect(body.model).toBe('gpt-5.6-luna')
    expect(body.store).toBe(false)
    expect(body.text.format.name).toBe('interpretation')
    expect(body.input).toHaveLength(2)
  })

  test('fails without an API key instead of sending an unauthenticated request', async () => {
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const { fetchImpl, calls } = mockFetch([{ body: completedResponse(interpretation) }])
      const result = expectError(
        await interpret({ context, turns }, { provider: 'openai', fetch: fetchImpl })
      )

      // The message names the provider's own variable, not a hardcoded one.
      expect(result.message).toContain('OPENAI_API_KEY')
      expect(result.retryable).toBe(false)
      expect(calls).toHaveLength(0)
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved
    }
  })

  test('reports a 200 whose body is not JSON as malformed', async () => {
    const { fetchImpl } = mockFetch([{ body: '<html>gateway</html>' }])

    const result = await interpret({ context, turns }, deterministic({ fetch: fetchImpl }))

    expect(result.kind).toBe('malformed')
  })
})

describe('retries', () => {
  function withSleepSpy(overrides: InterpretOptions = {}) {
    const sleeps: number[] = []
    const options = deterministic({
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      ...overrides
    })
    return { options, sleeps }
  }

  test('retries a 429 and succeeds', async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 429, body: { error: { message: 'slow down' } } },
      { body: completedResponse(interpretation) }
    ])
    const { options, sleeps } = withSleepSpy({ fetch: fetchImpl })

    expectOk(await interpret({ context, turns }, options))

    expect(calls).toHaveLength(2)
    // Half jitter with random() === 0.5 lands exactly mid-band.
    expect(sleeps).toEqual([300])
  })

  test('retries a 500 and gives up after the configured attempts', async () => {
    const { fetchImpl, calls } = mockFetch([{ status: 500, body: { error: { message: 'boom' } } }])
    const { options, sleeps } = withSleepSpy({ fetch: fetchImpl, maxRetries: 2 })

    const result = expectError(await interpret({ context, turns }, options))

    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([300, 600])
    expect(result.status).toBe(500)
    expect(result.retryable).toBe(true)
    expect(result.message).toContain('boom')
  })

  test('retries 503 and network failures', async () => {
    const { fetchImpl, calls } = mockFetch([
      new TypeError('fetch failed'),
      { status: 503, body: {} },
      { body: completedResponse(interpretation) }
    ])
    const { options } = withSleepSpy({ fetch: fetchImpl, maxRetries: 3 })

    expectOk(await interpret({ context, turns }, options))

    expect(calls).toHaveLength(3)
  })

  test.each([400, 401, 403, 404])('does not retry %i', async (status) => {
    const { fetchImpl, calls } = mockFetch([{ status, body: { error: { message: 'nope' } } }])
    const { options, sleeps } = withSleepSpy({ fetch: fetchImpl })

    const result = expectError(await interpret({ context, turns }, options))

    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(result.status).toBe(status)
    expect(result.retryable).toBe(false)
  })

  test('waits at least as long as Retry-After asks', async () => {
    const { fetchImpl } = mockFetch([
      { status: 429, headers: { 'retry-after': '2' } },
      { body: completedResponse(interpretation) }
    ])
    const { options, sleeps } = withSleepSpy({ fetch: fetchImpl })

    expectOk(await interpret({ context, turns }, options))

    expect(sleeps).toEqual([2_000])
  })

  test('gives up immediately when the reset is minutes away', async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 429, headers: { 'x-ratelimit-reset-requests': '6m0s' } }
    ])
    const { options, sleeps } = withSleepSpy({ fetch: fetchImpl })

    const result = expectError(await interpret({ context, turns }, options))

    // Sitting on a six-minute backoff mid-interview is worse than saying so.
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(result.retryAfterMs).toBe(360_000)
    expect(result.retryable).toBe(true)
    expect(result.message).toContain('360s')
  })

  test('reports each retry to the caller', async () => {
    const { fetchImpl } = mockFetch([
      { status: 500, body: {} },
      { body: completedResponse(interpretation) }
    ])
    const seen: { attempt: number; status: number | null }[] = []
    const { options } = withSleepSpy({
      fetch: fetchImpl,
      onRetry: (info) => seen.push({ attempt: info.attempt, status: info.status })
    })

    expectOk(await interpret({ context, turns }, options))

    expect(seen).toEqual([{ attempt: 0, status: 500 }])
  })
})

describe('cancellation', () => {
  test('returns immediately when the caller already aborted', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: completedResponse(interpretation) }])
    const controller = new AbortController()
    controller.abort()

    const result = expectError(
      await interpret(
        { context, turns },
        deterministic({ fetch: fetchImpl, signal: controller.signal })
      )
    )

    expect(result.aborted).toBe(true)
    expect(result.retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test('aborts an in-flight request without retrying it', async () => {
    const controller = new AbortController()
    const sleeps: number[] = []
    setTimeout(() => controller.abort(), 5)

    const result = expectError(
      await interpret(
        { context, turns },
        deterministic({
          fetch: hangingFetch,
          signal: controller.signal,
          sleep: async (ms: number) => {
            sleeps.push(ms)
          }
        })
      )
    )

    expect(result.aborted).toBe(true)
    expect(sleeps).toEqual([])
  })

  test('times out a hung request and treats it as retryable', async () => {
    const result = expectError(
      await interpret(
        { context, turns },
        deterministic({ fetch: hangingFetch, timeoutMs: 10, maxRetries: 0 })
      )
    )

    expect(result.message).toContain('timed out')
    expect(result.retryable).toBe(true)
    expect(result.aborted).toBe(false)
  })
})
