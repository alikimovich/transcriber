/**
 * The wiki: LLM-maintained markdown that lives inside the user's Obsidian vault.
 *
 * Every decision in this file follows from one fact — **a human reads and edits
 * these files by hand.** The wiki is not an app-private store that happens to be
 * markdown; it is a folder in someone's vault that they will open, annotate and
 * reorganise. So:
 *
 * - Nothing here overwrites a file it did not just generate. `scaffold()` creates
 *   only what is missing, and `writePage()` carries a page's unrecognised
 *   frontmatter through untouched, because Obsidian's property editor writes
 *   `tags:` / `aliases:` blocks that this module has no field for and no business
 *   deleting.
 * - Whole-file writes go through a temp file and `rename`, so an interrupted run
 *   can never truncate a page. The log is the exception: it is appended with
 *   `O_APPEND`, since rewriting the whole file to add one line is exactly the
 *   failure mode an append-only record exists to avoid.
 * - Page paths arrive from an LLM and are treated as untrusted: relative, inside
 *   the root, `.md` only.
 *
 * `index.md` is the one generated page. It is rebuilt from disk, contains no
 * timestamp, and is byte-stable for unchanged input so a rebuild does not dirty
 * the user's vault sync for no reason.
 */

import type { Dirent } from 'node:fs'
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WikiLayout, WikiPage } from './types.ts'

const SCHEMA_FILE = 'AGENTS.md'
const INDEX_FILE = 'index.md'
const LOG_FILE = 'log.md'
const PROFILE_FILE = 'profile.md'
const NOTES_FILE = 'notes.md'
const EXPERIENCE_DIR = 'experience'
const TARGET_DIR = 'target'

/**
 * Pages the wiki owns as machinery rather than content. They are excluded from
 * `listPages()` so the index never lists itself and the compile step never spends
 * budget on the log. `readPage('log.md')` still works if a caller wants them.
 */
const RESERVED_PAGES = new Set([SCHEMA_FILE, INDEX_FILE, LOG_FILE])

/** Owner-only: this is a resume, a salary history and a list of weaknesses. */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

export class Wiki {
  readonly root: string

  constructor(root: string) {
    // Resolved once so containment checks compare normalised absolute paths.
    this.root = resolve(root)
  }

  /**
   * `~/memory/interview-lens` — inside the Obsidian vault, not in Application
   * Support, because the whole point is that the user can read it. Overridable
   * through `INTERVIEW_LENS_WIKI`, which is what the tests use.
   */
  static defaultRoot(): string {
    const override = process.env.INTERVIEW_LENS_WIKI
    if (override !== undefined && override !== '') return override
    return join(homedir(), 'memory', 'interview-lens')
  }

  layout(): WikiLayout {
    return {
      root: this.root,
      indexPath: join(this.root, INDEX_FILE),
      logPath: join(this.root, LOG_FILE),
      schemaPath: join(this.root, SCHEMA_FILE)
    }
  }

  /**
   * Whether the wiki has been scaffolded, keyed on `AGENTS.md` rather than on the
   * directory: a user who makes an empty `interview-lens` folder in Obsidian has
   * no wiki yet, and answering "yes" there would skip the scaffold and leave them
   * with one. Re-scaffolding an existing wiki is harmless, so erring this way is
   * the safe direction.
   */
  async exists(): Promise<boolean> {
    return await isFile(this.layout().schemaPath)
  }

  /**
   * Create anything missing. Idempotent and non-destructive — the single most
   * important property in this file, since the target directory contains the
   * user's own writing.
   *
   * Seed files are created with `wx` (`O_EXCL`) rather than "check then write":
   * the kernel decides whether the file already exists, so there is no window in
   * which a check passes and a write clobbers.
   */
  async scaffold(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: DIR_MODE })
    await mkdir(join(this.root, EXPERIENCE_DIR), { recursive: true, mode: DIR_MODE })
    await mkdir(join(this.root, TARGET_DIR), { recursive: true, mode: DIR_MODE })

    const layout = this.layout()
    await createIfAbsent(layout.schemaPath, AGENTS_MD)
    await createIfAbsent(layout.logPath, LOG_MD)
    await createIfAbsent(join(this.root, PROFILE_FILE), PROFILE_MD)
    await createIfAbsent(join(this.root, NOTES_FILE), NOTES_MD)

    // index.md is generated, but scaffold still refuses to overwrite it: a user
    // who kept notes there would lose them, and `rebuildIndex()` is the caller's
    // explicit way to ask for a regeneration.
    if (!(await isFile(layout.indexPath))) await this.rebuildIndex()
  }

  /** `null` when the page does not exist. Never throws on a malformed page. */
  async readPage(relPath: string): Promise<WikiPage | null> {
    const full = this.pagePath(relPath)
    const raw = await readIfPresent(full)
    if (raw === null) return null
    return pageFromMarkdown(relative(this.root, full), raw)
  }

  /**
   * Write a page, preserving any frontmatter keys this module does not model.
   * The existing `title` and `summary` records are always replaced, whatever
   * shape they had — carrying an old one through would leave a duplicate key and
   * break the frontmatter for every parser, Obsidian's included.
   *
   * Does not touch `index.md`; a batch write should call `rebuildIndex()` once at
   * the end rather than paying for a rebuild per page.
   */
  async writePage(page: WikiPage): Promise<void> {
    const full = this.pagePath(page.path)
    const existing = await readIfPresent(full)
    const carried =
      existing === null
        ? []
        : parseDocument(existing).records.filter(
            (record) => record.key !== 'title' && record.key !== 'summary'
          )
    await writeAtomic(full, renderPage(page, carried))
  }

  /**
   * Every `.md` page under the root, sorted by path. `prefix` matches on path
   * segments, so `'target'` yields `target/*` and not `target-notes.md`.
   */
  async listPages(prefix?: string): Promise<WikiPage[]> {
    const paths = (await this.markdownPaths(this.root, '')).sort(compareStrings)
    const pages: WikiPage[] = []
    for (const relPath of paths) {
      if (!matchesPrefix(relPath, prefix)) continue
      const raw = await readIfPresent(join(this.root, relPath))
      // A page deleted between the walk and the read is simply not listed.
      if (raw === null) continue
      pages.push(pageFromMarkdown(relPath, raw))
    }
    return pages
  }

  /**
   * Regenerate `index.md` from what is on disk. Deliberately a full regeneration
   * rather than a merge: a merge would resurrect entries for pages the user
   * deleted, and a catalog that lies is worse than no catalog.
   */
  async rebuildIndex(): Promise<void> {
    const pages = await this.listPages()
    await writeAtomic(this.layout().indexPath, renderIndex(pages))
  }

  /**
   * Append one dated bullet. Uses `O_APPEND` instead of the atomic
   * temp-file-and-rename used everywhere else: rename replaces the whole file,
   * and a crash mid-replace of an append-only record could lose every earlier
   * entry. An interrupted append can only lose the tail.
   */
  async appendLog(entry: string, at: Date = new Date()): Promise<void> {
    // One entry is one bullet; embedded newlines would break the list shape.
    const text = entry.replace(/\s+/g, ' ').trim()
    if (text === '') return

    const path = this.layout().logPath
    await mkdir(this.root, { recursive: true, mode: DIR_MODE })
    await createIfAbsent(path, LOG_MD)
    const separator = (await endsWithNewline(path)) ? '' : '\n'
    await appendFile(path, `${separator}- ${stamp(at)} — ${text}\n`, {
      encoding: 'utf8',
      mode: FILE_MODE
    })
  }

  /** Slugs of the pages directly under `target/`, sorted. */
  async targets(): Promise<string[]> {
    const entries = await readdirIfPresent(join(this.root, TARGET_DIR))
    return entries
      .filter(
        (entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.md')
      )
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .sort(compareStrings)
  }

  /**
   * Resolve a page path, rejecting anything that leaves the root. These paths come
   * from a model, so `..`, absolute paths and NUL bytes are all assumed hostile
   * until proven otherwise. The `.md` requirement is part of the same guard: it
   * keeps a stray write from landing on `.obsidian/app.json` or a dotfile.
   */
  private pagePath(relPath: string): string {
    if (relPath === '') throw new Error('wiki: page path is empty')
    if (relPath.includes('\0')) throw new Error('wiki: page path contains a NUL byte')
    if (isAbsolute(relPath)) throw new Error(`wiki: page path must be relative: ${relPath}`)
    if (!relPath.endsWith('.md')) throw new Error(`wiki: page path must end in .md: ${relPath}`)

    const full = resolve(this.root, relPath)
    if (!full.startsWith(this.root + sep)) {
      throw new Error(`wiki: page path escapes the wiki root: ${relPath}`)
    }
    return full
  }

  /**
   * Recursive walk yielding root-relative `.md` paths. Symlinks are not followed
   * — `isDirectory()` and `isFile()` are both false for one — which rules out both
   * cycles and a link that reaches outside the vault. Dot entries are skipped so
   * `.obsidian/` and `.trash/` never appear as pages.
   */
  private async markdownPaths(directory: string, prefix: string): Promise<string[]> {
    // Tolerant of a missing directory so an unscaffolded wiki lists nothing
    // rather than throwing, and so a folder deleted mid-walk is not fatal.
    const entries = await readdirIfPresent(directory)
    const found: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        found.push(...(await this.markdownPaths(join(directory, entry.name), relPath)))
        continue
      }
      // Anything else (`.tmp` leftovers from an interrupted write included) is not
      // a page.
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      if (RESERVED_PAGES.has(relPath)) continue
      found.push(relPath)
    }
    return found
  }
}

/**
 * Slug for a page filename: lowercase, non-alphanumerics collapsed to `-`,
 * trimmed. Accents are folded rather than dropped so "Café Ops" is `cafe-ops`,
 * not `caf-ops`.
 */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  // A slug becomes a filename, and an empty one produces `.md` — a dotfile
  // Obsidian hides. Better a wrong name the user can see and rename.
  return slug === '' ? 'untitled' : slug
}

// --- page format -----------------------------------------------------------

type FrontmatterRecord = {
  /** `null` for lines that are not a `key:` line, e.g. a leading comment. */
  key: string | null
  /** Kept verbatim so unmodelled YAML (block lists, comments) survives a write. */
  lines: string[]
}

type ParsedDocument = {
  records: FrontmatterRecord[]
  title: string | null
  summary: string | null
  body: string
}

const DELIMITER = '---'
/**
 * A frontmatter key line. YAML needs a space after the colon for a plain scalar,
 * so `key:value` is deliberately not a key line — it is one scalar, and treating
 * it as a key would corrupt it on rewrite.
 */
const KEY_LINE = /^([^\s:][^:]*):(?:\s(.*))?$/
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/

/**
 * Split a markdown file into frontmatter records and body.
 *
 * Frontmatter is recognised exactly as Obsidian recognises it: `---` on the first
 * line, closed by the next line that is `---`. A file whose first line is a
 * thematic break is therefore misread — by every tool in the ecosystem, so
 * matching the convention beats being clever. Nothing is lost either way: an
 * unrecognised record is carried through verbatim on write.
 */
function parseDocument(raw: string): ParsedDocument {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))

  const close = lines[0] === DELIMITER ? lines.indexOf(DELIMITER, 1) : -1
  if (close === -1) return { records: [], title: null, summary: null, body: normalizeBody(text) }

  const records: FrontmatterRecord[] = []
  for (const line of lines.slice(1, close)) {
    const match = KEY_LINE.exec(line)
    const previous = records[records.length - 1]
    if (match === null && previous !== undefined) {
      previous.lines.push(line)
      continue
    }
    records.push({ key: match === null ? null : (match[1] ?? null), lines: [line] })
  }

  return {
    records,
    title: scalarOf(records, 'title'),
    summary: scalarOf(records, 'summary'),
    body: normalizeBody(lines.slice(close + 1).join('\n'))
  }
}

/**
 * The value of a single-line record. A record with continuation lines is left
 * alone — a `title:` spanning a YAML block scalar is not something this module
 * can rewrite faithfully, so it stays an unmodelled record and the title falls
 * back to the heading.
 */
function scalarOf(records: FrontmatterRecord[], key: string): string | null {
  const record = records.find((candidate) => candidate.key === key)
  if (record === undefined || record.lines.length !== 1) return null
  const match = KEY_LINE.exec(record.lines[0] ?? '')
  if (match === null) return null
  return parseScalar((match[2] ?? '').trim())
}

function parseScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1))
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

function unescapeDoubleQuoted(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') {
      out += value[i]
      continue
    }
    const next = value[++i]
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else if (next === '0') out += '\0'
    else if (next === 'u') {
      out += String.fromCharCode(Number.parseInt(value.slice(i + 1, i + 5), 16) || 0)
      i += 4
    } else out += next ?? ''
  }
  return out
}

/** Anything unprintable forces a quoted scalar; YAML has no plain form for it. */
const CONTROL = /\p{Cc}/u

/** Values a plain YAML scalar would come back as something other than a string. */
const YAML_LOOKALIKE =
  /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|\d{4}-\d{2}-\d{2}.*)$/i

/**
 * Emit a scalar that parses back to exactly this string — here and in any real
 * YAML parser, which is what "frontmatter survives a round trip" has to mean once
 * Obsidian's property editor is also reading the file.
 */
function serializeScalar(value: string): string {
  const plain =
    value !== '' &&
    value === value.trim() &&
    !CONTROL.test(value) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !value.includes(': ') &&
    !value.endsWith(':') &&
    !value.includes(' #') &&
    !YAML_LOOKALIKE.test(value)
  if (plain) return value
  if (value === '') return "''"

  let quoted = ''
  for (const char of value) {
    if (char === '\\') quoted += '\\\\'
    else if (char === '"') quoted += '\\"'
    else if (char === '\n') quoted += '\\n'
    else if (char === '\r') quoted += '\\r'
    else if (char === '\t') quoted += '\\t'
    else if (CONTROL.test(char)) quoted += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    else quoted += char
  }
  return `"${quoted}"`
}

/** Body text without its surrounding blank lines; the renderer re-adds exactly one. */
function normalizeBody(text: string): string {
  return text.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '')
}

function pageFromMarkdown(path: string, raw: string): WikiPage {
  const parsed = parseDocument(raw)
  return {
    path,
    // A hand-written page has no frontmatter; its `# heading` is the best title
    // available, and the filename is the last resort. Never an error: the user is
    // allowed to just make a note in Obsidian.
    title: nonEmpty(parsed.title) ?? headingTitle(parsed.body) ?? basename(path, '.md'),
    summary: parsed.summary ?? '',
    body: parsed.body
  }
}

function headingTitle(body: string): string | null {
  for (const line of body.split('\n')) {
    const match = HEADING.exec(line)
    if (match !== null) return nonEmpty(match[1]?.trim() ?? '')
  }
  return null
}

function nonEmpty(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value
}

/**
 * `title` and `summary` first, then every record this module did not model, in
 * the order it found them. Repeated writes are therefore byte-stable, which is
 * what keeps the vault's diffs readable.
 */
function renderPage(page: WikiPage, carried: FrontmatterRecord[]): string {
  const lines = [
    DELIMITER,
    `title: ${serializeScalar(page.title)}`,
    `summary: ${serializeScalar(page.summary)}`
  ]
  for (const record of carried) lines.push(...record.lines)
  lines.push(DELIMITER, '')

  const body = normalizeBody(page.body)
  if (body !== '') lines.push(body, '')
  return lines.join('\n')
}

// --- index -----------------------------------------------------------------

const INDEX_NOTICE =
  '*Generated from the pages on disk — every rebuild overwrites this file.\n' +
  'Write in [[notes]] or on a page instead; edits here will not survive.*'

/**
 * Categories in reading order. `Other` is not in the schema but exists so a page
 * that fits nowhere is still findable — silently omitting it from the catalog
 * would be a worse failure than an untidy heading.
 */
const CATEGORIES: { heading: string; matches: (path: string) => boolean }[] = [
  { heading: 'Profile', matches: (path) => path === PROFILE_FILE },
  { heading: 'Experience', matches: (path) => path.startsWith(`${EXPERIENCE_DIR}/`) },
  { heading: 'Targets', matches: (path) => path.startsWith(`${TARGET_DIR}/`) },
  { heading: 'Notes', matches: (path) => path === NOTES_FILE }
]

function renderIndex(pages: WikiPage[]): string {
  const remaining = [...pages]
  const sections: string[] = []

  for (const category of CATEGORIES) {
    const matched = remaining.filter((page) => category.matches(page.path))
    for (const page of matched) remaining.splice(remaining.indexOf(page), 1)
    if (matched.length > 0) sections.push(section(category.heading, matched))
  }
  if (remaining.length > 0) sections.push(section('Other', remaining))

  const body =
    sections.length === 0
      ? `${INDEX_NOTICE}\n\nNo pages yet.`
      : `${INDEX_NOTICE}\n\n${sections.join('\n\n')}`

  // No timestamp anywhere: an unchanged wiki must rebuild to identical bytes, or
  // every sync shows up as a modified file in the user's vault.
  return renderPage(
    { path: INDEX_FILE, title: 'Index', summary: 'Generated catalog of every page.', body },
    []
  )
}

function section(heading: string, pages: WikiPage[]): string {
  const entries = pages.map((page) => {
    const link = wikiLink(page.path, page.title)
    const summary = page.summary.replace(/\s+/g, ' ').trim()
    return summary === '' ? `- ${link}` : `- ${link} — ${summary}`
  })
  return `## ${heading}\n\n${entries.join('\n')}`
}

/**
 * Obsidian resolves `[[experience/acme]]` relative to the linking note, so a
 * root-relative path works even though the wiki is a subfolder of the vault.
 * Characters that are structural inside a wikilink have no escape, so a path
 * containing one falls back to a regular markdown link rather than emitting a
 * link that silently points nowhere.
 */
function wikiLink(path: string, title: string): string {
  const target = path.endsWith('.md') ? path.slice(0, -'.md'.length) : path
  const alias = title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[[\]|]/g, '-')
  if (/[[\]|#^]/.test(target)) return `[${alias}](${encodeURI(target)}.md)`
  return `[[${target}|${alias}]]`
}

// --- files -----------------------------------------------------------------

/** Distinguishes "no such page" from "this filesystem is broken". */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code: unknown }).code
  return typeof code === 'string' ? code : undefined
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    // EISDIR/ENOTDIR: something else occupies the path. Still "no page here".
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null
    throw error
  }
}

/** A wiki with no `target/` directory yet has no targets, not an error. */
async function readdirIfPresent(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function createIfAbsent(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: FILE_MODE })
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
}

/** Distinguishes writes racing within one process; `.tmp` is never listed as a page. */
let tempCounter = 0

/**
 * Write via a sibling temp file and `rename`, which is atomic within a directory:
 * a reader sees either the old page or the new one, never a truncated one.
 */
async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: DIR_MODE })
  const temp = `${target}.${process.pid}.${tempCounter++}.tmp`
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: FILE_MODE })
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Reads one byte, so a long log costs nothing to check before appending. */
async function endsWithNewline(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size === 0) return true
    const buffer = Buffer.alloc(1)
    await handle.read(buffer, 0, 1, size - 1)
    return buffer[0] === 0x0a
  } finally {
    await handle.close()
  }
}

/** UTC to the minute: sortable, unambiguous, and independent of the reader's zone. */
function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function matchesPrefix(path: string, prefix?: string): boolean {
  if (prefix === undefined || prefix === '') return true
  const trimmed = prefix.replace(/\/+$/, '')
  return path === trimmed || path.startsWith(`${trimmed}/`)
}

/** Code-unit order, so page order does not depend on the machine's locale. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// --- seed content ----------------------------------------------------------

/**
 * The schema layer of the LLM-wiki pattern: the document a future model reads
 * before it touches anything here. It is written once, at scaffold, and never
 * rewritten — the user may edit it, and their edits are the point.
 */
export const AGENTS_MD = `---
title: AGENTS
summary: How this wiki is organised, and the rules for editing it.
---

# AGENTS — how this wiki works

This folder is Interview Lens's long-term memory about **one candidate: you**.
It is written by a model during \`interview-lens context ingest\`, and read by a
model when compiling the few hundred tokens of context that accompany a live
interview hint.

It also lives in your Obsidian vault, so you can read every word of it, correct
anything wrong, and delete anything you would rather it not know. Hand edits are
expected and are never overwritten, with one exception noted below.

## Layout

| Path | Owner | What it holds |
| --- | --- | --- |
| \`AGENTS.md\` | schema | This file. Conventions for whoever edits the wiki. |
| \`index.md\` | **generated** | Catalog of every page. Rebuilt from disk; do not hand-edit. |
| \`log.md\` | append-only | One bullet per ingest or lint pass. Never rewritten. |
| \`profile.md\` | model + you | Who the candidate is: level, domains, working style. |
| \`notes.md\` | **you** | Freeform. Nothing here ever rewrites it. |
| \`experience/*.md\` | model + you | One page per role or substantial project. |
| \`target/*.md\` | model + you | One page per company or role being interviewed for. |

Filenames are slugs: lowercase, non-alphanumerics collapsed to \`-\`
(\`experience/acme-payments.md\`, \`target/globex-staff-backend.md\`).

## Page format

Every generated page is YAML frontmatter followed by markdown:

\`\`\`markdown
---
title: Acme — Payments Platform
summary: Led the ledger rewrite; the strongest scale and on-call story.
---

## What it was
...
\`\`\`

- \`title\` is how the page appears in \`index.md\`.
- \`summary\` is **one line**, under about 120 characters, written so that reading
  \`index.md\` top to bottom tells you what is in the wiki without opening a page.
- Other frontmatter keys — Obsidian tags, aliases, anything you add by hand — are
  preserved untouched when a page is rewritten.
- A page with no frontmatter is still valid. Its title comes from the first
  heading, or from the filename.

## Rules for a model editing this wiki

1. **One subject per page.** A role, a project, a company. If a page needs two
   \`##\` sections that share nothing, it is two pages.
2. **Prefer editing an existing page** over creating a near-duplicate. Check
   \`index.md\` first.
3. **Never invent.** Every claim traces to an ingested source or to something the
   user wrote. If a source is ambiguous, say so in the page rather than resolving
   it silently. An interview is the worst possible place to discover that the
   context was confidently wrong.
4. **Preserve human prose.** If a paragraph does not read like your own output,
   assume the user wrote it and leave it alone. Add; do not rewrite.
5. **Keep pages short.** A few hundred words. The compile step has a hard budget,
   and long pages get truncated in ways nobody controls.
6. **Cross-reference with wikilinks**: \`[[experience/acme-payments]]\`,
   \`[[target/globex-staff-backend]]\`. They work in Obsidian and cost nothing.
7. **Write for retrieval, not for prose.** Concrete nouns, numbers, system names,
   and the specific decisions the candidate made. "Improved reliability" is
   useless; "cut p99 checkout latency 2.4s → 380ms by batching ledger writes" is
   a story an interviewer can be answered with.
8. **Do not touch \`index.md\`** — it is regenerated. **Do not rewrite
   \`notes.md\`** — it is the user's.

## What must never be stored here

Interview transcripts, audio, recordings of any kind, API keys, and anything a
third party told the candidate in confidence. Transcripts live in memory for the
length of a session and are deliberately not persisted anywhere; this folder is
not the exception.

## Useful shape for a target page

\`\`\`markdown
## The company
## The role, as posted
## What they are likely probing for
## Which of my stories map to it
## Open questions to ask them
\`\`\`
`

const LOG_MD = `---
title: Log
summary: Append-only record of ingests and lint passes.
---

# Log

Newest entries at the bottom. Nothing above a new entry is ever rewritten.

`

const PROFILE_MD = `---
title: Profile
summary: Who the candidate is, in a paragraph.
---

# Profile

_Not filled in yet. Run \`interview-lens context ingest <resume.pdf>\`, or just
write this yourself — hand-written beats generated here._

## Summary

## Domains and depth

## How I work

## Known gaps
`

const NOTES_MD = `---
title: Notes
summary: Freeform notes, owned by the user.
---

# Notes

Anything you want the assistant to know that does not fit a page: what you are
optimising for, what you will not take, a phrase you keep fumbling.

This page is yours. Interview Lens reads it and never rewrites it.
`
