// xAI response parsing.
//
// The Chat Completions shape differs from OpenAI's Responses shape in three
// ways that matter, and each has a test: refusals arrive as a sibling field
// rather than a content part, `end_turn` is a success terminal with no OpenAI
// equivalent, and reasoning lands in its own field instead of the content.

import { describe, expect, test } from 'bun:test'
import { CHAT_COMPLETIONS_URL, xaiProvider } from '../src/providers/index.ts'
import type { Interpretation } from '../src/types.ts'

const interpretation: Interpretation = {
  intent: 'Whether you shape ambiguous problems or wait to be handed one',
  emphasis: 'How you framed the problem before proposing a solution',
  clarification: null,
  confidence: 'high'
}

function completion(
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'a3d1008e-0000-0000-0000-000000000000',
    object: 'chat.completion',
    model: 'grok-4.3',
    choices: [{ index: 0, message, finish_reason: 'stop', ...extra }],
    usage: {
      prompt_tokens: 812,
      completion_tokens: 61,
      total_tokens: 873,
      prompt_tokens_details: { cached_tokens: 768 }
    }
  }
}

const okMessage = {
  role: 'assistant',
  content: JSON.stringify(interpretation),
  refusal: null,
  reasoning_content: null
}

describe('xAI response parsing', () => {
  test('extracts the interpretation and the usage', () => {
    const result = xaiProvider.parseResponse(completion(okMessage))

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toEqual(interpretation)
    expect(result.responseId).toBe('a3d1008e-0000-0000-0000-000000000000')
    expect(result.usage).toEqual({
      inputTokens: 812,
      outputTokens: 61,
      totalTokens: 873,
      cachedInputTokens: 768
    })
  })

  test('treats end_turn as success — it has no OpenAI equivalent', () => {
    const result = xaiProvider.parseResponse(completion(okMessage, { finish_reason: 'end_turn' }))

    expect(result.kind).toBe('ok')
  })

  test('reports a truncated response rather than parsing a fragment', () => {
    const result = xaiProvider.parseResponse(
      completion({ ...okMessage, content: '{"intent":"partial' }, { finish_reason: 'length' })
    )

    expect(result.kind).toBe('incomplete')
    if (result.kind !== 'incomplete') return
    expect(result.reason).toBe('length')
  })

  test('detects a refusal, which arrives as a sibling field with null content', () => {
    const result = xaiProvider.parseResponse(
      completion({ role: 'assistant', content: null, refusal: 'I cannot help with that' })
    )

    expect(result.kind).toBe('refusal')
    if (result.kind !== 'refusal') return
    expect(result.message).toBe('I cannot help with that')
  })

  test('ignores reasoning content, which never contaminates the JSON', () => {
    const result = xaiProvider.parseResponse(
      completion({
        ...okMessage,
        reasoning_content: 'Let me think about what they are really asking...'
      })
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toEqual(interpretation)
  })

  test('reports an unexpected terminal rather than guessing', () => {
    const result = xaiProvider.parseResponse(
      completion(okMessage, { finish_reason: 'content_filter' })
    )

    expect(result.kind).toBe('incomplete')
    if (result.kind !== 'incomplete') return
    expect(result.reason).toBe('content_filter')
  })

  test('reports malformed JSON without throwing', () => {
    const result = xaiProvider.parseResponse(completion({ ...okMessage, content: 'not json' }))

    expect(result.kind).toBe('malformed')
    if (result.kind !== 'malformed') return
    expect(result.raw).toBe('not json')
  })

  // Shape validation is deliberately NOT the provider's job — it returns
  // whatever JSON came back, and `interpret()` checks it against the schema.
  test('returns well-formed JSON as-is, even when it is not an interpretation', () => {
    const result = xaiProvider.parseResponse(
      completion({ ...okMessage, content: JSON.stringify({ intent: 'only this' }) })
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toEqual({ intent: 'only this' })
  })

  test('handles a response with no choices', () => {
    expect(xaiProvider.parseResponse({ choices: [] }).kind).toBe('malformed')
    expect(xaiProvider.parseResponse({}).kind).toBe('malformed')
    expect(xaiProvider.parseResponse('nope').kind).toBe('malformed')
  })
})

describe('xAI request', () => {
  const args = {
    system: 'you are a helper',
    messages: ['setup context', 'transcript window'],
    schema: { type: 'object' },
    schemaName: 'interpretation',
    maxOutputTokens: 400,
    cacheKey: 'interview-lens:interpret-v1'
  }

  test('targets the chat completions endpoint', () => {
    expect(xaiProvider.buildRequest(args, 'k').url).toBe(CHAT_COMPLETIONS_URL)
  })

  test('turns reasoning off by default and on when asked', () => {
    const fast = xaiProvider.buildRequest(args, 'k').body as Record<string, unknown>
    expect(fast.reasoning_effort).toBe('none')

    const thorough = xaiProvider.buildRequest({ ...args, reasoning: true }, 'k').body as Record<
      string,
      unknown
    >
    expect(thorough.reasoning_effort).not.toBe('none')
  })

  test('puts the stable context ahead of the volatile transcript', () => {
    const body = xaiProvider.buildRequest(args, 'k').body as Record<string, any>

    // xAI's prefix cache matches message-by-message from the start, so the
    // ordering here is what makes a cache hit possible at all.
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'user'])
    expect(body.messages[1].content).toBe('setup context')
    expect(body.messages[2].content).toBe('transcript window')
  })

  test('omits the parameters that hard-error on reasoning models', () => {
    const body = xaiProvider.buildRequest(args, 'k').body as Record<string, unknown>

    for (const banned of ['presence_penalty', 'frequency_penalty', 'stop']) {
      expect(body).not.toHaveProperty(banned)
    }
  })
})
