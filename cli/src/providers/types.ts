// The seam between "what we ask" and "who we ask".
//
// The prompt, the schema and the result type are ours. Everything a specific
// vendor imposes — endpoint, envelope, auth header, where the text ends up in
// the response — lives behind this interface. Three provider changes in as many
// days is what motivated it.

import type { Interpretation, SetupContext, Turn } from '../types.ts'

export type ProviderId = 'openai' | 'xai'

/** The JSON Schema both providers enforce. Vendors differ only in the envelope. */
export const INTERPRETATION_SCHEMA = {
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
      // Strict modes require every property in `required`, so an optional field
      // is expressed as a null union rather than by omission.
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
} as const

export type BuildArgs = {
  context: SetupContext
  turns: Turn[]
  instructions: string
  /** Rendered setup context. Stable across a session — keep it first so it can
   *  serve as a cache prefix. */
  contextText: string
  /** Rendered transcript window. Volatile; must come last. */
  windowText: string
  model?: string
}

export type ProviderRequest = {
  url: string
  headers: Record<string, string>
  body: unknown
}

/**
 * What a parsed response can turn out to be.
 *
 * Deliberately narrower than `InterpretResult`: transport failures are the
 * caller's concern, not the provider's. A provider only classifies what came
 * back in a 2xx body.
 */
export type ParsedResponse =
  | {
      kind: 'ok'
      interpretation: Interpretation
      responseId: string | null
      usage: TokenUsage | null
    }
  | { kind: 'refusal'; message: string }
  | { kind: 'incomplete'; reason: string; message: string }
  | { kind: 'malformed'; message: string; raw: string | null }

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
}

export type Provider = {
  id: ProviderId
  /** Shown in `doctor` and error messages. */
  label: string
  defaultModel: string
  /** Environment variable checked before the Keychain. */
  envVar: string
  /** Keychain account name under the `interview-lens` service. */
  keychainAccount: string
  /** Where a user gets a key, for the installer and error messages. */
  consoleUrl: string
  buildRequest(args: BuildArgs, apiKey: string): ProviderRequest
  parseResponse(value: unknown): ParsedResponse
}
