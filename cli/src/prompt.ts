/**
 * Request construction for the interpretation call.
 *
 * Two things here are deliberate and should survive refactoring:
 *
 * 1. **No heuristic picks "the last interviewer question."** The whole labelled
 *    window is sent and the model decides what was asked. Real interview speech
 *    is full of restarts, two-part questions, back-channel ("mm-hm"), and
 *    interviewer turns that only make sense given what the candidate just said.
 *    A `findLast(t => t.channel === 'interviewer')` gets those wrong.
 * 2. **Static text first, volatile text last.** `instructions` holds the task
 *    description, then the setup context (stable for a whole session), then the
 *    transcript window. Prompt caching only pays off on a shared prefix.
 */

import type { SetupContext, Turn } from './types.ts'

export const INTERPRET_MODEL = 'gpt-5.6-luna'

/** Bump the suffix whenever the cached prefix (instructions/format) changes. */
export const PROMPT_CACHE_KEY = 'interview-lens:interpret-v1'

export const MAX_OUTPUT_TOKENS = 400

/** Guard against a pasted 50-page job description blowing up latency and cost. */
const MAX_CONTEXT_CHARS = 6000

/**
 * Strict structured output for the Responses API. Note the shape: `name`,
 * `strict` and `schema` are siblings under `text.format` — the nested
 * `json_schema` object is the Chat Completions shape and is rejected here.
 *
 * Under `strict: true` every property must appear in `required`, so optionality
 * is expressed as a `null` union, and `additionalProperties: false` is required.
 */
export const INTERPRETATION_FORMAT = {
  type: 'json_schema',
  name: 'interpretation',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description:
          'What the interviewer is actually probing for with this question, in at most 18 words.'
      },
      emphasis: {
        type: 'string',
        description:
          'Which dimension of experience a strong answer should foreground — not the answer itself. At most 18 words.'
      },
      clarification: {
        type: ['string', 'null'],
        description:
          'A short question the candidate could ask back if the request is ambiguous, otherwise null.'
      },
      confidence: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'How confident you are that you identified the question and its intent.'
      }
    },
    required: ['intent', 'emphasis', 'clarification', 'confidence'],
    additionalProperties: false
  }
} as const

export type ResponsesRequest = {
  model: string
  instructions: string
  input: { role: 'user'; content: { type: 'input_text'; text: string }[] }[]
  reasoning: { effort: 'none' }
  text: { verbosity: 'low'; format: typeof INTERPRETATION_FORMAT }
  max_output_tokens: number
  store: false
  prompt_cache_key: string
}

export const INSTRUCTIONS = `You support a candidate during a live job interview. They can glance at your output for about two seconds while someone is talking to them, so every word has to earn its place.

You will be given, in order: the candidate's setup context, then a transcript window of the conversation so far. Each line is labelled [interviewer] or [candidate]. The interviewer channel is captured from system audio and may contain more than one remote speaker. A line marked (in progress) is still being spoken and may end mid-sentence. Speech-to-text errors, dropped words and missing punctuation are normal — read through them.

Your job: work out what the interviewer has most recently asked or is driving at, and explain what it is probing for. Decide that yourself from the transcript; do not assume the last interviewer line is the question, and do not treat back-channel ("mm-hm", "right", "sure") as one.

Rules, in priority order:
1. Never write or draft the candidate's answer. No scripts, no example sentences they could read out, no "say that you...".
2. Never invent facts about the candidate. You know only what the setup context states. If a strong answer needs an experience you have no evidence for, say what kind of evidence would land, not that they have it.
3. If you cannot tell what is being asked, or the question is ambiguous, set confidence to "low" and put a short question the candidate could ask back in "clarification". Guessing confidently is the worst failure mode here.
4. Set "clarification" to null when the question is clear enough to answer as asked.
5. Be terse. "intent" and "emphasis" are at most 18 words each and are phrases, not sentences with preamble. No restating of the question, no "the interviewer wants to know whether".

"intent" is what is really being probed — the underlying competency or concern behind the words. "emphasis" is which dimension of their own experience the candidate should foreground, expressed generically. Set confidence to "high" only when the question is explicit and unambiguous in the transcript.`

/** Render the persistent setup context. Stable across a session, so it caches. */
export function formatSetupContext(context: SetupContext): string {
  const lines = ['# Setup context']
  const role = context.interviewerRole?.trim()
  lines.push('', '## Interviewer', role !== undefined && role !== '' ? role : '(not specified)')
  lines.push('', '## Role being interviewed for', orPlaceholder(context.jobDescription))
  lines.push('', "## Candidate's own notes", orPlaceholder(context.notes))
  return lines.join('\n')
}

/** Render the transcript window. Changes constantly, so it goes last. */
export function formatWindow(turns: Turn[]): string {
  const lines = ['# Transcript so far']
  if (turns.length === 0) {
    lines.push('', '(nothing has been transcribed yet)')
    return lines.join('\n')
  }
  lines.push('')
  for (const turn of turns) {
    const marker = turn.isFinal ? '' : ' (in progress)'
    lines.push(`[${turn.channel}]${marker} ${turn.text}`)
  }
  return lines.join('\n')
}

export type BuildRequestArgs = {
  context: SetupContext
  turns: Turn[]
  model?: string
}

/** Assemble the full `POST /v1/responses` body. */
export function buildRequestBody({
  context,
  turns,
  model = INTERPRET_MODEL
}: BuildRequestArgs): ResponsesRequest {
  return {
    model,
    instructions: INSTRUCTIONS,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: formatSetupContext(context) }] },
      { role: 'user', content: [{ type: 'input_text', text: formatWindow(turns) }] }
    ],
    // Lowest latency: this task is recall and classification, not deliberation.
    reasoning: { effort: 'none' },
    text: { verbosity: 'low', format: INTERPRETATION_FORMAT },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    // Interview transcripts are confidential; nothing is retained server-side.
    store: false,
    prompt_cache_key: PROMPT_CACHE_KEY
  }
}

function orPlaceholder(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return '(not provided)'
  if (trimmed.length <= MAX_CONTEXT_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_CONTEXT_CHARS)}\n…(truncated)`
}
