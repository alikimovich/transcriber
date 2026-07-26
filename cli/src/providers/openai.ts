// OpenAI, via the Responses API.
//
// Kept alongside the xAI provider so switching back is a config change rather
// than a rewrite.

import { describe, isRecord, readResponsesUsage, str } from './parsing.ts'
import type { CompletionArgs, ParsedResponse, Provider, ProviderRequest } from './types.ts'

export const RESPONSES_URL = 'https://api.openai.com/v1/responses'
export const DEFAULT_MODEL = 'gpt-5.6-luna'

function buildRequest(args: CompletionArgs, apiKey: string): ProviderRequest {
  return {
    url: RESPONSES_URL,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: {
      model: args.model ?? DEFAULT_MODEL,
      instructions: args.system,
      input: args.messages.map((text: string) => ({
        role: 'user',
        content: [{ type: 'input_text', text }]
      })),
      // Reasoning tokens are generated serially before any visible output, so
      // turning them off is the single biggest latency lever on the hint path.
      reasoning: { effort: args.reasoning === true ? 'medium' : 'none' },
      text: {
        verbosity: 'low',
        // On the Responses API `name`/`strict`/`schema` are siblings. The nested
        // `json_schema` object is the Chat Completions shape and is rejected.
        format: {
          type: 'json_schema',
          name: args.schemaName,
          strict: true,
          schema: args.schema
        }
      },
      max_output_tokens: args.maxOutputTokens,
      store: false,
      prompt_cache_key: args.cacheKey
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

  return {
    kind: 'ok',
    data: parsed,
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
