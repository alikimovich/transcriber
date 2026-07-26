// xAI (Grok), via Chat Completions.
//
// xAI offers both `/v1/responses` and `/v1/chat/completions` and labels the
// latter "legacy". We use Chat Completions anyway: it is stateless (the
// Responses API defaults to `store: true`, retaining inputs for 30 days), the
// structured-output shape is the better-documented of the two, and a single
// one-shot call gains nothing from the stateful endpoint. "Legacy" here means
// new features land elsewhere first, not imminent removal.

import { interpretationSchema } from '../types.ts'
import { describe, isRecord, readChatUsage, str, summarizeIssues } from './parsing.ts'
import {
  type BuildArgs,
  INTERPRETATION_SCHEMA,
  type ParsedResponse,
  type Provider,
  type ProviderRequest
} from './types.ts'

export const CHAT_COMPLETIONS_URL = 'https://api.x.ai/v1/chat/completions'

/**
 * grok-4.3 rather than the newer grok-4.5, deliberately.
 *
 * 4.5 cannot disable reasoning — its floor is `low` and its default is `high` —
 * so every call burns reasoning tokens before emitting a single character of
 * JSON. For a latency-critical extraction the reasoning is exactly what we do
 * not want. 4.3 is the only current model that accepts `reasoning_effort:
 * "none"`, and it is also cheaper.
 */
export const DEFAULT_MODEL = 'grok-4.3'

/** Default is 128,000 — far too high to leave alone. */
export const MAX_COMPLETION_TOKENS = 400

export const PROMPT_CACHE_KEY = 'interview-lens:interpret-v1'

function buildRequest(args: BuildArgs, apiKey: string): ProviderRequest {
  return {
    url: CHAT_COMPLETIONS_URL,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      // Sticky routing, so repeat calls land on a server that already holds the
      // cached prefix. Without it you frequently get a cache-cold instance.
      'x-grok-conv-id': PROMPT_CACHE_KEY
    },
    body: {
      model: args.model ?? DEFAULT_MODEL,
      // The single biggest latency lever. Note this also makes the request
      // legal: presence/frequency penalties and `stop` hard-error on reasoning
      // models, and 4.3 reasons at `low` unless told not to.
      reasoning_effort: 'none',
      // `max_tokens` is deprecated here, and the replacement defaults to 128k.
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0,
      prompt_cache_key: PROMPT_CACHE_KEY,
      messages: [
        { role: 'system', content: args.instructions },
        { role: 'user', content: args.contextText },
        { role: 'user', content: args.windowText }
      ],
      // Chat Completions nests the schema under `json_schema`. The Responses
      // API flattens it — do not copy this shape across endpoints.
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'interpretation',
          strict: true,
          schema: INTERPRETATION_SCHEMA
        }
      }
    }
  }
}

function parseResponse(value: unknown): ParsedResponse {
  if (!isRecord(value)) {
    return { kind: 'malformed', message: 'response was not a JSON object', raw: null }
  }

  const choices = Array.isArray(value.choices) ? value.choices : null
  const choice = choices?.[0]
  if (!isRecord(choice)) {
    return { kind: 'malformed', message: 'response contained no choices', raw: null }
  }

  const message = isRecord(choice.message) ? choice.message : null
  if (message === null) {
    return { kind: 'malformed', message: 'choice contained no message', raw: null }
  }

  // Refusals arrive as a sibling field, not as a content part, and must be
  // checked before parsing — `content` is null when the model declines.
  const refusal = str(message.refusal)
  if (refusal !== null) return { kind: 'refusal', message: refusal }

  const finish = str(choice.finish_reason)
  if (finish === 'length') {
    return {
      kind: 'incomplete',
      reason: 'length',
      message: 'response hit max_completion_tokens before finishing'
    }
  }
  // `end_turn` is an xAI value with no OpenAI equivalent and means success.
  // Anything other than the three known-good terminals is suspect.
  if (finish !== null && finish !== 'stop' && finish !== 'end_turn') {
    return {
      kind: 'incomplete',
      reason: finish,
      message: `response stopped unexpectedly (finish_reason ${finish})`
    }
  }

  // Reasoning, when enabled, lands in `message.reasoning_content` rather than
  // being mixed into `content`, so it never contaminates the JSON.
  const raw = str(message.content)
  if (raw === null) {
    return { kind: 'malformed', message: 'message contained no content', raw: null }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return { kind: 'malformed', message: `output was not JSON: ${describe(cause)}`, raw }
  }

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
    usage: readChatUsage(value.usage)
  }
}

export const xaiProvider: Provider = {
  id: 'xai',
  label: 'xAI (Grok)',
  defaultModel: DEFAULT_MODEL,
  envVar: 'XAI_API_KEY',
  keychainAccount: 'xai',
  consoleUrl: 'https://console.x.ai',
  buildRequest,
  parseResponse
}
