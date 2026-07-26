// Persisted preferences, distinct from the interview context in config.ts.
//
// Kept in its own file because the two have different lifetimes: setup context
// changes per interview, this changes when the user switches vendor.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir } from './config.ts'
import { isProviderId, type ProviderId } from './providers/index.ts'

const FILE_NAME = 'settings.json'

export type Settings = {
  provider: ProviderId | null
  model: string | null
}

export const EMPTY_SETTINGS: Settings = { provider: null, model: null }

export function settingsPath(): string {
  return join(configDir(), FILE_NAME)
}

/** Missing or corrupt settings degrade to defaults rather than failing launch. */
export async function loadSettings(): Promise<Settings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_SETTINGS
    const record = parsed as Record<string, unknown>
    return {
      provider: isProviderId(record.provider) ? record.provider : null,
      model: typeof record.model === 'string' && record.model !== '' ? record.model : null
    }
  } catch {
    return EMPTY_SETTINGS
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(configDir(), { recursive: true })
  await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
}
