/**
 * Persistence for the setup context — the job description, the candidate's
 * notes, and who is interviewing them.
 *
 * That is deliberately all that is stored. Transcripts live in memory for the
 * duration of a session and are never written to disk: the whole point of an
 * on-device capture pipeline is that a recording of someone's interview does not
 * outlive it. `store: false` on the API request is the other half of that.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type SetupContext, setupContextSchema } from './types.ts'

const APP_NAME = 'interview-lens'
const FILE_NAME = 'context.json'

export const EMPTY_CONTEXT: SetupContext = { jobDescription: '', notes: '' }

/**
 * `~/Library/Application Support/interview-lens`. Overridable through
 * `INTERVIEW_LENS_CONFIG_DIR`, which is what the tests use so they never touch a
 * real home directory.
 */
export function configDir(): string {
  const override = process.env.INTERVIEW_LENS_CONFIG_DIR
  if (override !== undefined && override !== '') return override
  return join(homedir(), 'Library', 'Application Support', APP_NAME)
}

export function contextPath(): string {
  return join(configDir(), FILE_NAME)
}

/**
 * Read the stored setup context. A missing, unreadable or corrupt file yields
 * the empty context rather than an error: a bad config should cost the user a
 * retype, not a launch failure.
 */
export async function loadContext(): Promise<SetupContext> {
  let raw: string
  try {
    raw = await readFile(contextPath(), 'utf8')
  } catch {
    return { ...EMPTY_CONTEXT }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...EMPTY_CONTEXT }
  }
  const result = setupContextSchema.safeParse(parsed)
  return result.success ? result.data : { ...EMPTY_CONTEXT }
}

/**
 * Write the setup context. Writes to a sibling temp file and renames, so an
 * interrupted save cannot leave a half-written file behind — `rename` within a
 * directory is atomic.
 */
export async function saveContext(context: SetupContext): Promise<void> {
  const target = contextPath()
  await mkdir(dirname(target), { recursive: true })
  const normalized: SetupContext = {
    jobDescription: context.jobDescription,
    notes: context.notes,
    ...(context.interviewerRole === undefined ? {} : { interviewerRole: context.interviewerRole })
  }
  const temp = `${target}.${process.pid}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Forget the stored setup context. Succeeds when there was nothing to forget. */
export async function clearContext(): Promise<void> {
  await rm(contextPath(), { force: true })
}
