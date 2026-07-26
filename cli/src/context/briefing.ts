// Reading the briefing.
//
// This is the whole runtime contract with the wiki: one short markdown file per
// target, written by an agent and editable by hand. Lens does not parse it, does
// not summarise it, and never calls a model to produce it — it reads the file
// and puts it in front of the transcript.
//
// Keeping it dumb is the point. The briefing is something the user can open,
// read and correct; anything Lens generated on the fly would be neither.

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadContext } from '../config.ts'
import { formatSetupContext } from '../prompt.ts'

/** Soft cap. A briefing over this is a sign the wiki leaked into it. */
export const BRIEFING_CHAR_WARNING = 3000

export function wikiRoot(): string {
  const override = process.env.INTERVIEW_LENS_WIKI
  if (override !== undefined && override !== '') return override
  return join(homedir(), 'memory', 'interview-lens')
}

export function briefingPath(target: string): string {
  return join(wikiRoot(), 'target', `${target}.briefing.md`)
}

export async function wikiExists(): Promise<boolean> {
  try {
    return (await stat(wikiRoot())).isDirectory()
  } catch {
    return false
  }
}

/** Target slugs that have a page, whether or not they have a briefing yet. */
export async function listTargets(): Promise<string[]> {
  try {
    const entries = await readdir(join(wikiRoot(), 'target'))
    return entries
      .filter((name) => name.endsWith('.md') && !name.endsWith('.briefing.md'))
      .map((name) => name.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

export type PromptContext = {
  text: string
  /** Where it came from, so `doctor` and `context show` can explain themselves. */
  source: 'briefing' | 'manual' | 'empty'
  path: string | null
  target: string | null
  characters: number
}

async function readBriefing(target: string): Promise<string | null> {
  try {
    const text = (await readFile(briefingPath(target), 'utf8')).trim()
    return text === '' ? null : text
  } catch {
    return null
  }
}

/**
 * What goes in front of the transcript on a hint request.
 *
 * Prefers the briefing; falls back to whatever `interview-lens setup` saved, so
 * the tool still works for someone who never set up a wiki.
 */
export async function resolvePromptContext(target: string | null): Promise<PromptContext> {
  if (target !== null) {
    const text = await readBriefing(target)
    if (text !== null) {
      return {
        text,
        source: 'briefing',
        path: briefingPath(target),
        target,
        characters: text.length
      }
    }
  }

  const manual = await loadContext()
  const rendered = formatSetupContext(manual).trim()
  const hasManual = manual.jobDescription.trim() !== '' || manual.notes.trim() !== ''

  return {
    text: hasManual ? rendered : '',
    source: hasManual ? 'manual' : 'empty',
    path: null,
    target,
    characters: hasManual ? rendered.length : 0
  }
}
