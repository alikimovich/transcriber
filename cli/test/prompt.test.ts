import { describe, expect, test } from 'bun:test'
import {
  buildRequestBody,
  formatSetupContext,
  formatWindow,
  INSTRUCTIONS,
  INTERPRET_MODEL,
  INTERPRETATION_FORMAT,
  PROMPT_CACHE_KEY
} from '../src/prompt.ts'
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

describe('request body', () => {
  const body = buildRequestBody({ context, turns })

  test('uses the interpretation model and the documented latency settings', () => {
    expect(body.model).toBe(INTERPRET_MODEL)
    expect(body.model).toBe('gpt-5.6-luna')
    expect(body.reasoning).toEqual({ effort: 'none' })
    expect(body.text.verbosity).toBe('low')
    expect(body.max_output_tokens).toBe(400)
  })

  test('does not let OpenAI retain the transcript, and keys the prompt cache', () => {
    expect(body.store).toBe(false)
    expect(body.prompt_cache_key).toBe(PROMPT_CACHE_KEY)
    expect(body.prompt_cache_key).toBe('interview-lens:interpret-v1')
  })

  test('puts the static task description in instructions and the transcript last', () => {
    expect(body.instructions).toBe(INSTRUCTIONS)
    expect(body.input).toHaveLength(2)

    const first = body.input[0]?.content[0]?.text ?? ''
    const last = body.input[1]?.content[0]?.text ?? ''
    expect(first).toContain('# Setup context')
    expect(last).toContain('# Transcript so far')
    // The volatile part has to come after the stable part or caching cannot hit.
    expect(last).toContain('[interviewer]')
    expect(first).not.toContain('[interviewer]')
  })

  test('carries the setup context and both channel labels into the request', () => {
    const serialized = JSON.stringify(body)

    expect(serialized).toContain('Staff engineer on the payments platform')
    expect(serialized).toContain('Led the ledger rewrite.')
    expect(serialized).toContain('Engineering manager for the payments org')
    expect(serialized).toContain('[interviewer]')
    expect(serialized).toContain('[candidate]')
  })

  test('uses input_text parts in a user role', () => {
    for (const message of body.input) {
      expect(message.role).toBe('user')
      for (const part of message.content) expect(part.type).toBe('input_text')
    }
  })

  test('honours a model override', () => {
    expect(buildRequestBody({ context, turns, model: 'gpt-test' }).model).toBe('gpt-test')
  })
})

describe('structured output format', () => {
  test('uses the Responses shape, with name a sibling of schema', () => {
    const format = INTERPRETATION_FORMAT

    expect(format.type).toBe('json_schema')
    expect(format.name).toBe('interpretation')
    expect(format.strict).toBe(true)
    expect(format.schema.type).toBe('object')
    // The Chat Completions nesting would put these under `json_schema`.
    expect(format).not.toHaveProperty('json_schema')
  })

  test('satisfies the constraints strict mode imposes', () => {
    const schema = INTERPRETATION_FORMAT.schema

    expect(schema.additionalProperties).toBe(false)
    // Under strict mode every property must be required; optionality is a null union.
    const required: string[] = [...schema.required]
    const declared: string[] = Object.keys(schema.properties)
    expect(required.sort()).toEqual(declared.sort())
    expect(schema.properties.clarification.type).toEqual(['string', 'null'])
    expect(schema.properties.confidence.enum).toEqual(['low', 'medium', 'high'])
  })

  test('agrees with the client-side validator, so drift cannot go unnoticed', () => {
    const jsonSchemaKeys = Object.keys(INTERPRETATION_FORMAT.schema.properties).sort()
    const zodKeys = Object.keys(interpretationSchema.shape).sort()

    expect(zodKeys).toEqual(jsonSchemaKeys)
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
