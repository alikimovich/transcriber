// Provider registry and selection.

import { openaiProvider } from './openai.ts'
import type { Provider, ProviderId } from './types.ts'
import { xaiProvider } from './xai.ts'

export { openaiProvider, RESPONSES_URL } from './openai.ts'
export * from './types.ts'
export { CHAT_COMPLETIONS_URL, xaiProvider } from './xai.ts'

export const PROVIDERS: Record<ProviderId, Provider> = {
  xai: xaiProvider,
  openai: openaiProvider
}

export const DEFAULT_PROVIDER_ID: ProviderId = 'xai'

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'xai' || value === 'openai'
}

/**
 * Resolve which provider to use.
 *
 * Precedence: an explicit argument, then `INTERVIEW_LENS_PROVIDER`, then the
 * saved setting, then the default. The env var exists so a single run can be
 * pointed elsewhere without disturbing the saved choice — useful when comparing
 * two providers on the same conversation.
 */
export function resolveProvider(explicit?: ProviderId | null, saved?: ProviderId | null): Provider {
  if (explicit && isProviderId(explicit)) return PROVIDERS[explicit]

  const fromEnv = process.env.INTERVIEW_LENS_PROVIDER
  if (isProviderId(fromEnv)) return PROVIDERS[fromEnv]

  if (saved && isProviderId(saved)) return PROVIDERS[saved]
  return PROVIDERS[DEFAULT_PROVIDER_ID]
}
