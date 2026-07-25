import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearContext,
  configDir,
  contextPath,
  EMPTY_CONTEXT,
  loadContext,
  saveContext
} from '../src/config.ts'
import type { SetupContext } from '../src/types.ts'

const ENV_KEY = 'INTERVIEW_LENS_CONFIG_DIR'

let directory: string
let savedOverride: string | undefined

beforeEach(async () => {
  savedOverride = process.env[ENV_KEY]
  directory = await mkdtemp(join(tmpdir(), 'interview-lens-test-'))
  process.env[ENV_KEY] = directory
})

afterEach(async () => {
  if (savedOverride === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedOverride
  }
  await rm(directory, { recursive: true, force: true })
})

const context: SetupContext = {
  jobDescription: 'Senior platform engineer',
  notes: 'Ask about the on-call rotation.',
  interviewerRole: 'Hiring manager'
}

describe('location', () => {
  test('defaults to Application Support under the home directory', () => {
    delete process.env[ENV_KEY]

    expect(configDir()).toContain(join('Library', 'Application Support', 'interview-lens'))
    expect(contextPath().endsWith(join('interview-lens', 'context.json'))).toBe(true)
  })

  test('an override redirects the whole path', () => {
    expect(contextPath()).toBe(join(directory, 'context.json'))
  })
})

describe('round trip', () => {
  test('saves and reloads the setup context', async () => {
    await saveContext(context)

    expect(await loadContext()).toEqual(context)
  })

  test('creates the directory if it does not exist yet', async () => {
    process.env[ENV_KEY] = join(directory, 'nested', 'deeper')

    await saveContext(context)

    expect(await loadContext()).toEqual(context)
  })

  test('omits an unset interviewer role rather than writing null', async () => {
    await saveContext({ jobDescription: 'a', notes: 'b' })

    const raw = JSON.parse(await readFile(contextPath(), 'utf8'))
    expect(raw).toEqual({ jobDescription: 'a', notes: 'b' })
    expect('interviewerRole' in raw).toBe(false)
  })

  test('overwrites a previous save without leaving a temp file behind', async () => {
    await saveContext(context)
    await saveContext({ ...context, notes: 'replaced' })

    expect((await loadContext()).notes).toBe('replaced')
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(directory)).toEqual(['context.json'])
  })

  test('stores only the setup context, never a transcript', async () => {
    await saveContext(context)

    const raw = JSON.parse(await readFile(contextPath(), 'utf8'))
    expect(Object.keys(raw).sort()).toEqual(['interviewerRole', 'jobDescription', 'notes'])
  })
})

describe('recovery', () => {
  test('a missing file loads as the empty context', async () => {
    expect(await loadContext()).toEqual(EMPTY_CONTEXT)
  })

  test('a corrupt file loads as the empty context rather than throwing', async () => {
    await writeFile(contextPath(), '{ this is not json')

    expect(await loadContext()).toEqual(EMPTY_CONTEXT)
  })

  test('a file with the wrong shape loads as the empty context', async () => {
    await writeFile(contextPath(), JSON.stringify({ jobDescription: 42 }))

    expect(await loadContext()).toEqual(EMPTY_CONTEXT)
  })

  test('the returned empty context is a fresh object each time', async () => {
    const first = await loadContext()
    first.notes = 'mutated'

    expect((await loadContext()).notes).toBe('')
  })
})

describe('clearContext', () => {
  test('forgets a stored context', async () => {
    await saveContext(context)

    await clearContext()

    expect(await loadContext()).toEqual(EMPTY_CONTEXT)
  })

  test('is a no-op when there is nothing stored', async () => {
    await clearContext()
    await clearContext()

    expect(await loadContext()).toEqual(EMPTY_CONTEXT)
  })
})
