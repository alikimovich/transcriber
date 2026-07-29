/**
 * The conversation-log store.
 *
 * A recorded session is a self-describing folder inside the user's Obsidian
 * vault, laid out so an LLM (or the user) can navigate the archive months later
 * without this tool: a compressed audio file, a markdown transcript, and a
 * machine-readable `meta.json`. A generated `index.md` catalogues everything and
 * an `AGENTS.md` documents the schema.
 *
 * Nothing here reasons about audio or transcription — it only writes what a
 * finished session produced. Writes go through a temp file + rename so an
 * interrupted save never leaves a half-written transcript behind.
 */

import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { Channel, Turn } from './types.ts'

/**
 * `~/memory/conversations`, inside the Obsidian vault. Overridable through
 * `INTERVIEW_LENS_CONVERSATIONS`, which is what the tests use so they never
 * touch the real vault.
 */
export function conversationsRoot(): string {
  const override = process.env.INTERVIEW_LENS_CONVERSATIONS
  if (override !== undefined && override !== '') return override
  return join(homedir(), 'memory', 'conversations')
}

/** A session's on-disk locations, handed back the moment its folder is created. */
export type Session = {
  /** Absolute path to the session directory. */
  dir: string
  /** `<dir>/audio.m4a` — the helper writes this via `--record`. */
  audioPath: string
  transcriptPath: string
  metaPath: string
  /** `<dir>/log.txt` — the capture diagnostics log, appended live. */
  logPath: string
  /** Display title; falls back to the folder-derived timestamp when untitled. */
  title: string
  slug: string | null
  startedAt: Date
}

/** Everything known about a session once capture has ended. */
export type SessionResult = {
  turns: Turn[]
  endedAt: Date
  /** Human-readable capture source, e.g. "all system audio" or "zoom". */
  source: string
  channels: Channel[]
  sampleRate: number | null
}

/** The shape written to `meta.json` and read back to rebuild the index. */
export type SessionMeta = {
  title: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  source: string
  channels: Channel[]
  audioFile: string
  sampleRate: number | null
}

const AUDIO_FILE = 'audio.m4a'
const TRANSCRIPT_FILE = 'transcript.md'
const META_FILE = 'meta.json'
const LOG_FILE = 'log.txt'
const INDEX_FILE = 'index.md'
const AGENTS_FILE = 'AGENTS.md'

const CHANNEL_LABEL: Record<Channel, string> = { me: 'Me', them: 'Them' }

export class ConversationStore {
  constructor(private readonly root: string = conversationsRoot()) {}

  /**
   * Create a fresh session directory and return its paths. Called before capture
   * starts, because the helper needs the audio path up front.
   *
   * Two sessions started in the same minute would otherwise collide; the second
   * gets a `-2` suffix, the third `-3`, and so on. Directory creation is the
   * collision check — `mkdir` without `recursive` fails on an existing dir, so
   * the loop cannot race two callers onto the same folder.
   */
  async createSession(opts: { title?: string; startedAt?: Date } = {}): Promise<Session> {
    const startedAt = opts.startedAt ?? new Date()
    const slug = slugify(opts.title ?? '')
    const stamp = timestampSlug(startedAt)
    const base = slug ? `${stamp}-${slug}` : stamp

    const parent = join(this.root, year(startedAt), month(startedAt))
    await mkdir(parent, { recursive: true })

    let dir = join(parent, base)
    for (let n = 2; ; n++) {
      try {
        await mkdir(dir)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        dir = join(parent, `${base}-${n}`)
      }
    }

    return {
      dir,
      audioPath: join(dir, AUDIO_FILE),
      transcriptPath: join(dir, TRANSCRIPT_FILE),
      metaPath: join(dir, META_FILE),
      logPath: join(dir, LOG_FILE),
      title: opts.title?.trim() || stamp,
      slug,
      startedAt
    }
  }

  /**
   * Write the transcript and metadata for a finished session, then refresh the
   * catalogue and schema docs. The audio file is the helper's responsibility and
   * is not touched here.
   */
  async finalize(session: Session, result: SessionResult): Promise<void> {
    const durationSeconds = Math.max(
      0,
      Math.round((result.endedAt.getTime() - session.startedAt.getTime()) / 1000)
    )
    const meta: SessionMeta = {
      title: session.title,
      startedAt: session.startedAt.toISOString(),
      endedAt: result.endedAt.toISOString(),
      durationSeconds,
      source: result.source,
      channels: result.channels,
      audioFile: AUDIO_FILE,
      sampleRate: result.sampleRate
    }

    await atomicWrite(session.transcriptPath, renderTranscript(session, result, meta))
    await atomicWrite(session.metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    await this.ensureAgentsDoc()
    await this.rebuildIndex()
  }

  /**
   * Ensure the store root exists and is writable, creating it if missing. Used by
   * `doctor` as a scaffold check; returns the root so the caller can report it.
   */
  async ensureRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true })
    // A round-trip is the only reliable writability test — permissions alone
    // don't account for a read-only mount.
    const probe = join(this.root, `.write-probe.${process.pid}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
    await this.ensureAgentsDoc()
    return this.root
  }

  /**
   * Regenerate `index.md` from the sessions actually on disk, newest first. Built
   * by scanning rather than appended to, so a hand-deleted session heals itself
   * on the next write.
   */
  async rebuildIndex(): Promise<void> {
    const sessions = await this.scanSessions()
    sessions.sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt))

    const lines = [
      '# Conversations',
      '',
      'Recorded sessions, newest first. Generated by interview-lens — edits are',
      'overwritten. See AGENTS.md for the folder schema.',
      ''
    ]
    if (sessions.length === 0) {
      lines.push('_No sessions recorded yet._')
    } else {
      for (const { relPath, meta } of sessions) {
        const started = new Date(meta.startedAt)
        const when = `${isoDate(started)} ${hourMinute(started)}`
        lines.push(
          `- ${when} · ${formatDuration(meta.durationSeconds)} · ` +
            `[${meta.title}](${relPath}) · ${meta.source}`
        )
      }
    }
    await atomicWrite(join(this.root, INDEX_FILE), `${lines.join('\n')}\n`)
  }

  /** Write the schema doc, but only if the user has not created one already. */
  async ensureAgentsDoc(): Promise<void> {
    const path = join(this.root, AGENTS_FILE)
    try {
      await readFile(path, 'utf8')
      return // Present already — never clobber the user's edits.
    } catch {
      // Missing; fall through and write it.
    }
    await mkdir(this.root, { recursive: true })
    await atomicWrite(path, AGENTS_DOC)
  }

  // -------------------------------------------------------------------------

  /** Every session found under `<root>/YYYY/MM/*`, paired with its metadata. */
  private async scanSessions(): Promise<{ relPath: string; meta: SessionMeta }[]> {
    const found: { relPath: string; meta: SessionMeta }[] = []
    for (const yearDir of await subdirs(this.root, /^\d{4}$/)) {
      for (const monthDir of await subdirs(join(this.root, yearDir), /^\d{2}$/)) {
        const monthPath = join(this.root, yearDir, monthDir)
        for (const sessionDir of await subdirs(monthPath, /./)) {
          const dir = join(monthPath, sessionDir)
          const meta = await readMeta(join(dir, META_FILE))
          if (meta === null) continue
          // POSIX separators regardless of platform; these are Obsidian links.
          const relPath = relative(this.root, join(dir, TRANSCRIPT_FILE)).split(/[\\/]/).join('/')
          found.push({ relPath, meta })
        }
      }
    }
    return found
  }
}

// ---------------------------------------------------------------------------
// Session log
// ---------------------------------------------------------------------------

/**
 * The capture diagnostics log, `log.txt` in the session folder.
 *
 * Appended line by line as things happen — not buffered and written at the end —
 * so a session that crashes or is killed still leaves the evidence behind. This
 * exists because a garbled recording once shipped with no trace of why: the
 * helper's stderr said exactly what was wrong (a format mismatch) and vanished
 * with the process.
 *
 * Appends are deliberately fire-and-forget-safe: a log write failing must never
 * take the session down, so errors are swallowed.
 */
export class SessionLog {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  /** Append one timestamped line. Serialized so lines never interleave. */
  append(message: string): void {
    const stamp = logStamp(new Date())
    this.chain = this.chain
      .then(() => appendFile(this.path, `${stamp}  ${message}\n`))
      .catch(() => {})
  }

  /** Resolves when every append issued so far has hit the disk. */
  flush(): Promise<void> {
    return this.chain
  }
}

/** `HH:MM:SS` local time — matches how the user thinks about a live session. */
function logStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTranscript(session: Session, result: SessionResult, meta: SessionMeta): string {
  const startSeconds = session.startedAt.getTime() / 1000
  const header = [
    `# ${session.title}`,
    '',
    `- Date: ${isoDate(session.startedAt)}`,
    `- Started: ${hourMinute(session.startedAt)}`,
    `- Duration: ${formatDuration(meta.durationSeconds)}`,
    `- Source: ${result.source}`,
    `- Audio: ${AUDIO_FILE} (stereo — me = left, them = right)`,
    `- Capture log: ${LOG_FILE}`,
    '',
    '---',
    ''
  ]

  const body = result.turns
    .map((turn) => {
      const stamp = relativeStamp(turn.startedAt - startSeconds)
      return `**[${stamp}] ${CHANNEL_LABEL[turn.channel]}:** ${turn.text}`
    })
    .join('\n\n')

  return `${header.join('\n')}${body}${body ? '\n' : '_No speech was transcribed._\n'}`
}

/** `[mm:ss]` relative to session start; minutes overflow past 99 for long logs. */
function relativeStamp(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds))
  const m = Math.floor(clamped / 60)
  const s = clamped % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`
}

// ---------------------------------------------------------------------------
// Naming helpers (all local time — the archive is for a human in one place)
// ---------------------------------------------------------------------------

const year = (d: Date) => String(d.getFullYear())
const month = (d: Date) => String(d.getMonth() + 1).padStart(2, '0')
const day = (d: Date) => String(d.getDate()).padStart(2, '0')

function timestampSlug(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${year(d)}-${month(d)}-${day(d)}-${hh}${mm}`
}

function isoDate(d: Date): string {
  return `${year(d)}-${month(d)}-${day(d)}`
}

function hourMinute(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Lowercase, non-alphanumerics to dashes, trimmed. Empty input yields null. */
export function slugify(text: string): string | null {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? null : slug
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function atomicWrite(target: string, contents: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  try {
    await writeFile(temp, contents, 'utf8')
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Directory names directly under `dir` matching `pattern`; `[]` if absent. */
async function subdirs(dir: string, pattern: RegExp): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && pattern.test(e.name))
    .map((e) => e.name)
    .sort()
}

async function readMeta(path: string): Promise<SessionMeta | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SessionMeta
  } catch {
    // Missing or corrupt meta.json — skip it so one bad folder cannot break the
    // whole index.
    return null
  }
}

const AGENTS_DOC = `# Conversation archive

Recorded meeting/conversation logs, written by \`interview-lens record\`. This is
a plain-file archive meant to stay readable without the tool.

## Layout

\`\`\`
<root>/
  index.md            generated catalogue, newest first (do not hand-edit)
  AGENTS.md           this file
  YYYY/MM/<session>/   one folder per session
    audio.m4a         stereo AAC — left channel = me (mic), right = them (system audio)
    transcript.md     speaker-labelled, timestamped transcript
    meta.json         machine-readable session metadata
    log.txt           capture diagnostics: helper output, audio formats, level
                      summaries, restarts. Read this first when a recording
                      sounds wrong or a transcript is empty.
\`\`\`

A session folder is named \`YYYY-MM-DD-HHMM\` (local time), optionally suffixed
with a slug from the session title, and a \`-2\`, \`-3\`, … disambiguator if two
sessions started in the same minute.

## meta.json

\`\`\`json
{
  "title": "string",
  "startedAt": "ISO 8601",
  "endedAt": "ISO 8601",
  "durationSeconds": 0,
  "source": "what was captured, e.g. all system audio",
  "channels": ["me", "them"],
  "audioFile": "audio.m4a",
  "sampleRate": 48000
}
\`\`\`

## transcript.md

A header block (title, date, start, duration, source, audio note) followed by
turns of the form \`**[mm:ss] Me:** …\` / \`**[mm:ss] Them:** …\`, where the
timestamp is relative to session start. \`Me\` is the microphone, \`Them\` is the
system audio.
`
