// API key resolution, per provider.
//
// Keys live in the login Keychain rather than an exported shell variable, so
// they are not visible to every process the user starts and do not end up in a
// dotfile or shell history. The provider's env var still wins, which keeps CI,
// one-off overrides, and `XAI_API_KEY=… interview-lens run` working.

import { spawnSync } from 'node:child_process'
import type { Provider } from './providers/index.ts'

export const KEYCHAIN_SERVICE = 'interview-lens'

const cache = new Map<string, string | null>()

/** Reads a provider's key from the login Keychain. Returns null when absent. */
export function readKeychainApiKey(account: string): string | null {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
    { encoding: 'utf8' }
  )
  // A missing item exits non-zero; that is an ordinary outcome, not an error.
  if (result.status !== 0) return null
  const value = (result.stdout ?? '').trim()
  return value === '' ? null : value
}

/**
 * The key to authenticate with, or undefined when none is configured.
 *
 * Cached for the process lifetime: this is read on every interpretation, and
 * shelling out to `security` each time would add latency to the one path where
 * latency is the whole point.
 */
export function loadApiKey(provider: Provider): string | undefined {
  const fromEnv = process.env[provider.envVar]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv

  if (!cache.has(provider.keychainAccount)) {
    cache.set(provider.keychainAccount, readKeychainApiKey(provider.keychainAccount))
  }
  return cache.get(provider.keychainAccount) ?? undefined
}

/** Forget cached keys. Only useful after storing a new one in-process. */
export function resetApiKeyCache(): void {
  cache.clear()
}

/** Where a provider's key came from, for `doctor` to report without printing it. */
export function apiKeySource(provider: Provider): 'env' | 'keychain' | 'none' {
  if (process.env[provider.envVar]) return 'env'
  return loadApiKey(provider) ? 'keychain' : 'none'
}
