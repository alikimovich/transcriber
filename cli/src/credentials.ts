// API key resolution.
//
// The key is kept in the login Keychain rather than an exported shell variable,
// so it isn't visible to every process the user starts and doesn't end up in a
// dotfile or shell history. An explicit `OPENAI_API_KEY` still wins, which
// keeps CI, one-off overrides, and `OPENAI_API_KEY=… interview-lens run`
// working.

import { spawnSync } from 'node:child_process'

export const KEYCHAIN_SERVICE = 'interview-lens'
export const KEYCHAIN_ACCOUNT = 'openai'

let cached: string | null | undefined

/** Reads the key from the login Keychain. Returns null when absent. */
export function readKeychainApiKey(): string | null {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
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
 * Cached for the process lifetime: this is read on every interpretation and
 * shelling out to `security` each time would add latency to the one path where
 * latency is the whole point.
 */
export function loadApiKey(): string | undefined {
  const fromEnv = process.env.OPENAI_API_KEY
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv

  if (cached === undefined) cached = readKeychainApiKey()
  return cached ?? undefined
}

/** Forget the cached key. Only useful after storing a new one in-process. */
export function resetApiKeyCache(): void {
  cached = undefined
}

/** Where the key came from, for `doctor` to report without printing it. */
export function apiKeySource(): 'env' | 'keychain' | 'none' {
  if (process.env.OPENAI_API_KEY) return 'env'
  return loadApiKey() ? 'keychain' : 'none'
}
