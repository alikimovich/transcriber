// The seam between "what we ask" and "who we ask".
//
// The prompt, the schema and the result type are ours. Everything a specific
// vendor imposes — endpoint, envelope, auth header, where the text ends up in
// the response — lives behind this interface. Three provider changes in as many
// days is what motivated it.

// Providers are deliberately ignorant of what is being asked. They know how to
// send a system prompt plus ordered user messages and get schema-conformant
// JSON back; interpreting that JSON is the caller's job.

export type ProviderId = 'openai' | 'xai'

/** The interpretation schema. Vendors differ only in the envelope around it. */
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

export type CompletionArgs = {
  /** System prompt. Stable — leads the prefix cache. */
  system: string
  /**
   * User messages in order, stable content first. Both providers match their
   * prefix cache message-by-message from the start of the list, so putting
   * volatile content last is what makes a cache hit possible at all.
   */
  messages: string[]
  /** JSON Schema the response must conform to. */
  schema: object
  /** Schema name; must match `[a-zA-Z0-9_-]`. */
  schemaName: string
  maxOutputTokens: number
  model?: string
  /** Stable key for the provider's prefix cache. */
  cacheKey: string
  /**
   * Whether the model should reason before answering. Off for latency-critical
   * calls; on for one-off work like ingesting a resume, where quality matters
   * more than the first token arriving quickly.
   */
  reasoning?: boolean
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
      /** Parsed JSON. Validating its shape is the caller's job. */
      data: unknown
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
  buildRequest(args: CompletionArgs, apiKey: string): ProviderRequest
  parseResponse(value: unknown): ParsedResponse
}
