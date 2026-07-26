import { describe, expect, test } from 'bun:test'
import { formatSetupContext, formatWindow, INSTRUCTIONS } from '../src/prompt.ts'
import { INTERPRETATION_SCHEMA, openaiProvider, xaiProvider } from '../src/providers/index.ts'
import { interpretationSchema, type SetupContext, type Turn } from '../src/types.ts'
import { T0 } from './helpers.ts'

const context: SetupContext = {
  jobDescription: 'Staff engineer on the payments platform, heavy on distributed systems.',
  notes: 'Led the ledger rewrite. Weakest on frontend questions.',
  interviewerRole: 'Engineering manager for the payments org'
}

const turns: Turn[] = [
  {
    channel: 'interviewer',
    text: 'Tell me about a system you owned end to end.',
    startedAt: T0,
    endedAt: T0 + 4,
    isFinal: true
  },
  {
    channel: 'candidate',
    text: 'The ledger rewrite, mostly.',
    startedAt: T0 + 5,
    endedAt: T0 + 7,
    isFinal: true
  },
  {
    channel: 'interviewer',
    text: 'And what would you do',
    startedAt: T0 + 8,
    endedAt: T0 + 9,
    isFinal: false
  }
]

describe('setup context', () => {
  test('includes every field the user provided', () => {
    const rendered = formatSetupContext(context)

    expect(rendered).toContain('Staff engineer on the payments platform')
    expect(rendered).toContain('Led the ledger rewrite.')
    expect(rendered).toContain('Engineering manager for the payments org')
  })

  test('marks unprovided fields rather than leaving a blank section', () => {
    const rendered = formatSetupContext({ jobDescription: '', notes: '   ' })

    expect(rendered).toContain('(not provided)')
    expect(rendered).toContain('(not specified)')
  })

  test('truncates a runaway job description', () => {
    const rendered = formatSetupContext({ jobDescription: 'x'.repeat(20_000), notes: '' })

    expect(rendered).toContain('…(truncated)')
    expect(rendered.length).toBeLessThan(7_000)
  })
})

describe('transcript window', () => {
  test('labels both channels', () => {
    const rendered = formatWindow(turns)

    expect(rendered).toContain('[interviewer] Tell me about a system you owned end to end.')
    expect(rendered).toContain('[candidate] The ledger rewrite, mostly.')
  })

  test('flags a turn that is still being spoken', () => {
    const rendered = formatWindow(turns)

    expect(rendered).toContain('[interviewer] (in progress) And what would you')
  })

  test('preserves conversational order', () => {
    const rendered = formatWindow(turns)
    const interviewer = rendered.indexOf('Tell me about a system')
    const candidate = rendered.indexOf('The ledger rewrite')

    expect(interviewer).toBeGreaterThan(-1)
    expect(candidate).toBeGreaterThan(interviewer)
  })

  test('says so explicitly when nothing has been heard yet', () => {
    expect(formatWindow([])).toContain('(nothing has been transcribed yet)')
  })
})

/** Provider bodies are deliberately untyped at the seam; narrow here. */
function field(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined
  }, body)
}

describe('structured output', () => {
  const args = {
    system: INSTRUCTIONS,
    messages: ['setup context', 'transcript window'],
    schema: INTERPRETATION_SCHEMA,
    schemaName: 'interpretation',
    maxOutputTokens: 400,
    cacheKey: 'interview-lens:interpret-v1'
  }

  test('the shared schema satisfies what strict mode imposes', () => {
    const schema = INTERPRETATION_SCHEMA

    expect(schema.additionalProperties).toBe(false)
    // Every property must be required; optionality is expressed as a null union.
    const required: string[] = [...schema.required]
    const declared: string[] = Object.keys(schema.properties)
    expect(required.sort()).toEqual(declared.sort())
    expect(schema.properties.clarification.type).toEqual(['string', 'null'])
    expect(schema.properties.confidence.enum).toEqual(['low', 'medium', 'high'])
  })

  test('agrees with the client-side validator, so drift cannot go unnoticed', () => {
    const jsonSchemaKeys = Object.keys(INTERPRETATION_SCHEMA.properties).sort()
    const zodKeys = Object.keys(interpretationSchema.shape).sort()

    expect(zodKeys).toEqual(jsonSchemaKeys)
  })

  test('OpenAI uses the flattened Responses shape', () => {
    const body = openaiProvider.buildRequest(args, 'k').body
    const format = field(body, 'text.format') as Record<string, unknown>

    expect(format.type).toBe('json_schema')
    expect(format.name).toBe('interpretation')
    expect(format.strict).toBe(true)
    // The Chat Completions nesting would put these under `json_schema`.
    expect(format).not.toHaveProperty('json_schema')
  })

  test('xAI uses the nested Chat Completions shape', () => {
    const body = xaiProvider.buildRequest(args, 'k').body
    const format = field(body, 'response_format') as Record<string, unknown>

    expect(format.type).toBe('json_schema')
    // The flattened Responses shape would put `name` here instead.
    expect(format).not.toHaveProperty('name')
    expect(field(format, 'json_schema.name')).toBe('interpretation')
    expect(field(format, 'json_schema.strict')).toBe(true)
    expect(field(format, 'json_schema.schema')).toEqual(INTERPRETATION_SCHEMA)
  })

  test('both providers disable reasoning and cap output', () => {
    const openai = openaiProvider.buildRequest(args, 'k').body
    expect(field(openai, 'reasoning.effort')).toBe('none')
    expect(field(openai, 'max_output_tokens')).toBeLessThanOrEqual(400)
    expect(field(openai, 'store')).toBe(false)

    const xai = xaiProvider.buildRequest(args, 'k').body as Record<string, unknown>
    // grok-4.3 reasons at `low` unless told otherwise, and that also makes
    // penalties/stop legal to omit rather than error.
    expect(xai.reasoning_effort).toBe('none')
    // `max_tokens` is deprecated here and the replacement defaults to 128k.
    expect(xai).not.toHaveProperty('max_tokens')
    expect(xai.max_completion_tokens).toBeLessThanOrEqual(400)
  })

  test('the xAI request carries a cache key on both the body and the header', () => {
    const request = xaiProvider.buildRequest(args, 'k')
    const body = request.body as Record<string, unknown>

    expect(body.prompt_cache_key).toBeTruthy()
    // Sticky routing; without it repeat calls often land cache-cold.
    expect(request.headers['x-grok-conv-id']).toBe(String(body.prompt_cache_key))
    expect(request.headers.authorization).toBe('Bearer k')
  })
})

describe('instructions', () => {
  test('forbid answering for the candidate and inventing facts', () => {
    expect(INSTRUCTIONS).toContain('Never write or draft')
    expect(INSTRUCTIONS).toContain('Never invent facts')
  })

  test('require low confidence and a clarifying question when the ask is unclear', () => {
    expect(INSTRUCTIONS).toContain('confidence to "low"')
    expect(INSTRUCTIONS).toContain('clarification')
  })

  test('leave identifying the question to the model', () => {
    expect(INSTRUCTIONS).toContain('do not assume the last interviewer line is the question')
  })
})
