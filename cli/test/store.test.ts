// Conversation store tests.
//
// No network, no audio: these exercise the on-disk layout only, with
// INTERVIEW_LENS_CONVERSATIONS pointed at a throwaway temp dir so the real
// Obsidian vault is never touched.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ConversationStore, conversationsRoot, slugify } from '../src/store.ts'
import type { Channel, Turn } from '../src/types.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'il-conversations-'))
  process.env.INTERVIEW_LENS_CONVERSATIONS = root
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.INTERVIEW_LENS_CONVERSATIONS
})

/** A local-time date, used to make folder names and stamps deterministic. */
function at(h: number, m: number): Date {
  return new Date(2026, 6, 27, h, m, 0) // 2026-07-27, local
}

function turn(channel: Channel, text: string, base: Date, offsetSeconds: number): Turn {
  const startedAt = base.getTime() / 1000 + offsetSeconds
  return { channel, text, startedAt, endedAt: startedAt + 2, isFinal: true }
}

describe('conversationsRoot', () => {
  test('honours the env override', () => {
    expect(conversationsRoot()).toBe(root)
  })
})

describe('slugify', () => {
  test('lowercases, collapses non-alphanumerics, and trims dashes', () => {
    expect(slugify('  Weekly Sync!! ')).toBe('weekly-sync')
    expect(slugify('1:1 with Ana')).toBe('1-1-with-ana')
  })
  test('returns null when nothing usable remains', () => {
    expect(slugify('')).toBeNull()
    expect(slugify('—')).toBeNull()
  })
})

describe('createSession', () => {
  test('names the folder YYYY/MM/YYYY-MM-DD-HHMM-slug in local time', async () => {
    const store = new ConversationStore()
    const session = await store.createSession({ title: 'Weekly Sync', startedAt: at(14, 32) })

    expect(session.dir).toBe(join(root, '2026', '07', '2026-07-27-1432-weekly-sync'))
    expect(session.audioPath).toBe(join(session.dir, 'audio.m4a'))
    expect(session.title).toBe('Weekly Sync')
    expect(session.slug).toBe('weekly-sync')
    // The directory is created eagerly so the helper can write into it.
    expect((await readdir(join(root, '2026', '07'))).length).toBe(1)
  })

  test('omits the slug and falls back to the stamp as a title when untitled', async () => {
    const store = new ConversationStore()
    const session = await store.createSession({ startedAt: at(9, 5) })

    expect(basename(session.dir)).toBe('2026-07-27-0905')
    expect(session.slug).toBeNull()
    expect(session.title).toBe('2026-07-27-0905')
  })

  test('suffixes -2, -3 when sessions collide in the same minute', async () => {
    const store = new ConversationStore()
    const a = await store.createSession({ title: 'Sync', startedAt: at(14, 32) })
    const b = await store.createSession({ title: 'Sync', startedAt: at(14, 32) })
    const c = await store.createSession({ title: 'Sync', startedAt: at(14, 32) })

    expect(basename(a.dir)).toBe('2026-07-27-1432-sync')
    expect(basename(b.dir)).toBe('2026-07-27-1432-sync-2')
    expect(basename(c.dir)).toBe('2026-07-27-1432-sync-3')
  })
})

describe('finalize', () => {
  test('renders a labelled, timestamped transcript', async () => {
    const store = new ConversationStore()
    const started = at(14, 32)
    const session = await store.createSession({ title: 'Weekly Sync', startedAt: started })

    await store.finalize(session, {
      turns: [
        turn('them', 'Tell me about the migration.', started, 3),
        turn('me', 'Sure, I led the platform team.', started, 7),
        turn('them', 'What broke?', started, 63)
      ],
      endedAt: new Date(started.getTime() + 723_000), // +12m03s
      source: 'zoom',
      channels: ['me', 'them'],
      sampleRate: 48000
    })

    const md = await readFile(session.transcriptPath, 'utf8')
    expect(md).toContain('# Weekly Sync')
    expect(md).toContain('- Date: 2026-07-27')
    expect(md).toContain('- Started: 14:32')
    expect(md).toContain('- Duration: 12m 03s')
    expect(md).toContain('- Source: zoom')
    expect(md).toContain('- Audio: audio.m4a (stereo — me = left, them = right)')
    expect(md).toContain('**[00:03] Them:** Tell me about the migration.')
    expect(md).toContain('**[00:07] Me:** Sure, I led the platform team.')
    expect(md).toContain('**[01:03] Them:** What broke?')
  })

  test('writes a machine-readable meta.json', async () => {
    const store = new ConversationStore()
    const started = at(14, 32)
    const session = await store.createSession({ title: 'Weekly Sync', startedAt: started })

    await store.finalize(session, {
      turns: [turn('me', 'Hi.', started, 1)],
      endedAt: new Date(started.getTime() + 90_000),
      source: 'all system audio',
      channels: ['me', 'them'],
      sampleRate: 48000
    })

    const meta = JSON.parse(await readFile(session.metaPath, 'utf8'))
    expect(meta).toEqual({
      title: 'Weekly Sync',
      startedAt: started.toISOString(),
      endedAt: new Date(started.getTime() + 90_000).toISOString(),
      durationSeconds: 90,
      source: 'all system audio',
      channels: ['me', 'them'],
      audioFile: 'audio.m4a',
      sampleRate: 48000
    })
  })

  test('handles a session with no transcribed speech', async () => {
    const store = new ConversationStore()
    const started = at(14, 32)
    const session = await store.createSession({ startedAt: started })

    await store.finalize(session, {
      turns: [],
      endedAt: new Date(started.getTime() + 5_000),
      source: 'all system audio',
      channels: ['them'],
      sampleRate: null
    })

    const md = await readFile(session.transcriptPath, 'utf8')
    expect(md).toContain('_No speech was transcribed._')
  })
})

describe('index.md', () => {
  test('rebuilds a reverse-chronological catalogue from disk', async () => {
    const store = new ConversationStore()

    const early = at(14, 32)
    const s1 = await store.createSession({ title: 'Morning Sync', startedAt: early })
    await store.finalize(s1, {
      turns: [turn('them', 'Hi.', early, 1)],
      endedAt: new Date(early.getTime() + 60_000),
      source: 'zoom',
      channels: ['me', 'them'],
      sampleRate: 48000
    })

    const late = at(16, 0)
    const s2 = await store.createSession({ title: 'Afternoon Review', startedAt: late })
    await store.finalize(s2, {
      turns: [turn('them', 'Hey.', late, 1)],
      endedAt: new Date(late.getTime() + 120_000),
      source: 'all system audio',
      channels: ['me', 'them'],
      sampleRate: 48000
    })

    const index = await readFile(join(root, 'index.md'), 'utf8')
    expect(index).toContain('# Conversations')
    // Newest first.
    const afternoon = index.indexOf('Afternoon Review')
    const morning = index.indexOf('Morning Sync')
    expect(afternoon).toBeGreaterThanOrEqual(0)
    expect(morning).toBeGreaterThan(afternoon)
    // Links are relative, POSIX-separated paths to each transcript.
    expect(index).toContain('(2026/07/2026-07-27-1432-morning-sync/transcript.md)')
    expect(index).toContain('(2026/07/2026-07-27-1600-afternoon-review/transcript.md)')
    expect(index).toContain('· 2m 00s ·')
  })

  test('self-heals when a session folder is deleted', async () => {
    const store = new ConversationStore()
    const started = at(14, 32)
    const session = await store.createSession({ title: 'Doomed', startedAt: started })
    await store.finalize(session, {
      turns: [turn('me', 'Bye.', started, 1)],
      endedAt: new Date(started.getTime() + 30_000),
      source: 'zoom',
      channels: ['me', 'them'],
      sampleRate: 48000
    })
    expect(await readFile(join(root, 'index.md'), 'utf8')).toContain('Doomed')

    rmSync(session.dir, { recursive: true, force: true })
    await store.rebuildIndex()

    const index = await readFile(join(root, 'index.md'), 'utf8')
    expect(index).not.toContain('Doomed')
    expect(index).toContain('_No sessions recorded yet._')
  })
})

describe('AGENTS.md and ensureRoot', () => {
  test('ensureRoot creates the root and a schema doc, and reports writable', async () => {
    rmSync(root, { recursive: true, force: true })
    const store = new ConversationStore()

    const reported = await store.ensureRoot()
    expect(reported).toBe(root)
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('Conversation archive')
  })

  test('never clobbers a user-edited AGENTS.md', async () => {
    const store = new ConversationStore()
    await store.ensureRoot()
    await writeFile(join(root, 'AGENTS.md'), 'my own notes', 'utf8')

    const started = at(14, 32)
    const session = await store.createSession({ title: 'Sync', startedAt: started })
    await store.finalize(session, {
      turns: [turn('me', 'Hi.', started, 1)],
      endedAt: new Date(started.getTime() + 10_000),
      source: 'zoom',
      channels: ['me', 'them'],
      sampleRate: 48000
    })

    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('my own notes')
  })
})
