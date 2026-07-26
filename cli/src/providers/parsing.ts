// Small helpers shared by provider response parsers.

import type { TokenUsage } from './types.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function summarizeIssues(error: {
  issues: { path: PropertyKey[]; message: string }[]
}): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

/** Usage in the OpenAI-compatible shape both providers happen to use. */
export function readChatUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : null
  return {
    inputTokens: num(value.prompt_tokens) ?? 0,
    outputTokens: num(value.completion_tokens) ?? 0,
    totalTokens: num(value.total_tokens) ?? 0,
    cachedInputTokens: num(details?.cached_tokens) ?? 0
  }
}

/** Usage in the OpenAI Responses shape. */
export function readResponsesUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : null
  return {
    inputTokens: num(value.input_tokens) ?? 0,
    outputTokens: num(value.output_tokens) ?? 0,
    totalTokens: num(value.total_tokens) ?? 0,
    cachedInputTokens: num(details?.cached_tokens) ?? 0
  }
}
