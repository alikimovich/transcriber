// OpenAI, via the Responses API.
//
// Kept alongside the xAI provider so switching back is a config change rather
// than a rewrite.

import { interpretationSchema } from '../types.ts'
import { describe, isRecord, readResponsesUsage, str, summarizeIssues } from './parsing.ts'
import {
  type BuildArgs,
  INTERPRETATION_SCHEMA,
  type ParsedResponse,
  type Provider,
  type ProviderRequest
} from './types.ts'

export const RESPONSES_URL = 'https://api.openai.com/v1/responses'
export const DEFAULT_MODEL = 'gpt-5.6-luna'
export const MAX_OUTPUT_TOKENS = 400

/** Bump the suffix whenever the cached prefix (instructions/schema) changes. */
export const PROMPT_CACHE_KEY = 'interview-lens:interpret-v1'

function buildRequest(args: BuildArgs, apiKey: string): ProviderRequest {
  return {
    url: RESPONSES_URL,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: {
      model: args.model ?? DEFAULT_MODEL,
      instructions: args.instructions,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: args.contextText }] },
        { role: 'user', content: [{ type: 'input_text', text: args.windowText }] }
      ],
      // Reasoning tokens are generated serially before any visible output, so
      // turning them off is the single biggest latency lever here.
      reasoning: { effort: 'none' },
      text: {
        verbosity: 'low',
        // On the Responses API `name`/`strict`/`schema` are siblings. The nested
        // `json_schema` object is the Chat Completions shape and is rejected.
        format: {
          type: 'json_schema',
          name: 'interpretation',
          strict: true,
          schema: INTERPRETATION_SCHEMA
        }
      },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      store: false,
      prompt_cache_key: PROMPT_CACHE_KEY
    }
  }
}

/**
 * Walk `output[] → message → content[] → output_text`.
 *
 * Three things this has to get right: skip the leading `reasoning` item rather
 * than indexing `output[0]`, notice a `refusal` part even though the response
 * still reports `status: "completed"`, and treat anything unexpected as
 * malformed rather than throwing into the render loop.
 */
function parseResponse(value: unknown): ParsedResponse {
  if (!isRecord(value)) {
    return { kind: 'malformed', message: 'response was not a JSON object', raw: null }
  }

  const status = typeof value.status === 'string' ? value.status : 'unknown'
  if (status !== 'completed') {
    const details = isRecord(value.incomplete_details) ? value.incomplete_details : null
    const error = isRecord(value.error) ? value.error : null
    const reason =
      str(details?.reason) ?? str(error?.message) ?? (status === 'unknown' ? 'missing' : status)
    return {
      kind: 'incomplete',
      reason,
      message: `response did not complete (status ${status}, reason ${reason})`
    }
  }

  if (!Array.isArray(value.output)) {
    return { kind: 'malformed', message: 'response had no output array', raw: null }
  }

  let refusal: string | null = null
  const chunks: string[] = []
  for (const item of value.output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (!isRecord(part)) continue
      if (part.type === 'refusal') {
        refusal ??= str(part.refusal) ?? str(part.text) ?? 'the model refused to answer'
      } else if (part.type === 'output_text') {
        const text = str(part.text)
        if (text !== null) chunks.push(text)
      }
    }
  }

  if (refusal !== null) return { kind: 'refusal', message: refusal }
  if (chunks.length === 0) {
    return { kind: 'malformed', message: 'response contained no output_text content', raw: null }
  }

  const raw = chunks.join('')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return { kind: 'malformed', message: `output was not JSON: ${describe(cause)}`, raw }
  }

  // Defense in depth: strict mode should guarantee this, but schema drift should
  // degrade to "no suggestion", not a crash.
  const validated = interpretationSchema.safeParse(parsed)
  if (!validated.success) {
    return {
      kind: 'malformed',
      message: `output did not match the interpretation schema: ${summarizeIssues(validated.error)}`,
      raw
    }
  }

  return {
    kind: 'ok',
    interpretation: validated.data,
    responseId: str(value.id),
    usage: readResponsesUsage(value.usage)
  }
}

export const openaiProvider: Provider = {
  id: 'openai',
  label: 'OpenAI',
  defaultModel: DEFAULT_MODEL,
  envVar: 'OPENAI_API_KEY',
  keychainAccount: 'openai',
  consoleUrl: 'https://platform.openai.com/api-keys',
  buildRequest,
  parseResponse
}
