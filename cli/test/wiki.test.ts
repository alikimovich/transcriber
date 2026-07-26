import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WikiPage } from '../src/context/types.ts'
import { AGENTS_MD, slugify, Wiki } from '../src/context/wiki.ts'

const ENV_KEY = 'INTERVIEW_LENS_WIKI'

let directory: string
let root: string
let wiki: Wiki
let savedOverride: string | undefined

beforeEach(async () => {
  savedOverride = process.env[ENV_KEY]
  directory = await mkdtemp(join(tmpdir(), 'interview-lens-wiki-'))
  // A level below the temp dir, so scaffold has to create the root itself.
  root = join(directory, 'vault', 'interview-lens')
  wiki = new Wiki(root)
})

afterEach(async () => {
  if (savedOverride === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = savedOverride
  }
  await rm(directory, { recursive: true, force: true })
})

/** Every file under `dir`, keyed by relative path, for byte-for-byte comparison. */
async function snapshot(dir: string, prefix = ''): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      for (const [key, value] of await snapshot(join(dir, entry.name), relPath)) {
        files.set(key, value)
      }
    } else {
      files.set(relPath, await readFile(join(dir, entry.name), 'utf8'))
    }
  }
  return files
}

function page(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    path: 'experience/acme.md',
    title: 'Acme Payments',
    summary: 'Led the ledger rewrite.',
    body: '## What it was\n\nA ledger.',
    ...overrides
  }
}

describe('location', () => {
  test('defaults to the Obsidian vault, not Application Support', () => {
    delete process.env[ENV_KEY]

    expect(Wiki.defaultRoot()).toBe(join(homedir(), 'memory', 'interview-lens'))
  })

  test('an override redirects the root', () => {
    process.env[ENV_KEY] = '/tmp/somewhere-else'

    expect(Wiki.defaultRoot()).toBe('/tmp/somewhere-else')
  })

  test('layout names the schema, index and log', () => {
    expect(wiki.layout()).toEqual({
      root,
      indexPath: join(root, 'index.md'),
      logPath: join(root, 'log.md'),
      schemaPath: join(root, 'AGENTS.md')
    })
  })
})

describe('scaffold', () => {
  test('creates the whole layout', async () => {
    expect(await wiki.exists()).toBe(false)

    await wiki.scaffold()

    expect(await wiki.exists()).toBe(true)
    const files = await snapshot(root)
    expect([...files.keys()].sort()).toEqual([
      'AGENTS.md',
      'index.md',
      'log.md',
      'notes.md',
      'profile.md'
    ])
    expect(
      (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).length
    ).toBe(2)
    expect(await readdir(join(root, 'experience'))).toEqual([])
    expect(await readdir(join(root, 'target'))).toEqual([])
    expect(files.get('AGENTS.md')).toBe(AGENTS_MD)
  })

  test('an empty directory is not a wiki', async () => {
    await mkdir(root, { recursive: true })

    expect(await wiki.exists()).toBe(false)
  })

  test('running it twice preserves modified content byte for byte', async () => {
    await wiki.scaffold()
    // Everything the user could plausibly have touched, including the two files
    // the wiki treats as generated.
    await writeFile(join(root, 'profile.md'), 'my own profile, hand written\n')
    await writeFile(join(root, 'notes.md'), 'do not lose this\n')
    await writeFile(join(root, 'index.md'), 'I edited the index anyway\n')
    await writeFile(join(root, 'AGENTS.md'), '# my rules\n')
    await writeFile(join(root, 'log.md'), '- 2020-01-01 00:00 UTC — first\n')
    await wiki.writePage(page())
    const before = await snapshot(root)

    await wiki.scaffold()
    await wiki.scaffold()

    expect(await snapshot(root)).toEqual(before)
  })

  test('replaces only what is missing', async () => {
    await wiki.scaffold()
    await rm(join(root, 'profile.md'))
    await writeFile(join(root, 'notes.md'), 'kept\n')

    await wiki.scaffold()

    expect((await wiki.readPage('profile.md'))?.title).toBe('Profile')
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('kept\n')
  })

  test('the fresh index lists the seeded pages', async () => {
    await wiki.scaffold()

    const index = await readFile(join(root, 'index.md'), 'utf8')
    expect(index).toContain('[[profile|Profile]]')
    expect(index).toContain('[[notes|Notes]]')
  })
})

describe('page format', () => {
  test('frontmatter round trips, including values YAML would mangle', async () => {
    const awkward = page({
      title: 'Acme: Payments #2 "the rewrite"',
      summary: 'no',
      body: '- a\n- b'
    })

    await wiki.writePage(awkward)

    expect(await wiki.readPage('experience/acme.md')).toEqual(awkward)
  })

  test('an empty summary round trips as empty, not as the string null', async () => {
    await wiki.writePage(page({ summary: '' }))

    const read = await wiki.readPage('experience/acme.md')
    expect(read?.summary).toBe('')
    expect(read?.title).toBe('Acme Payments')
  })

  test('a title with a newline stays on one frontmatter line', async () => {
    await wiki.writePage(page({ title: 'one\ntwo' }))

    const raw = await readFile(join(root, 'experience/acme.md'), 'utf8')
    expect(raw.split('\n')[1]).toBe('title: "one\\ntwo"')
    expect((await wiki.readPage('experience/acme.md'))?.title).toBe('one\ntwo')
  })

  test('rewriting a page is byte stable', async () => {
    await wiki.writePage(page())
    const first = await readFile(join(root, 'experience/acme.md'), 'utf8')

    const read = await wiki.readPage('experience/acme.md')
    if (read === null) throw new Error('expected a page')
    await wiki.writePage(read)

    expect(await readFile(join(root, 'experience/acme.md'), 'utf8')).toBe(first)
    expect(first.endsWith('\n')).toBe(true)
  })

  test('writing creates missing directories', async () => {
    await wiki.writePage(page({ path: 'target/globex/staff-backend.md' }))

    expect(await wiki.readPage('target/globex/staff-backend.md')).not.toBeNull()
  })

  test('a hand-written page with no frontmatter takes its title from the heading', async () => {
    await mkdir(join(root, 'experience'), { recursive: true })
    await writeFile(
      join(root, 'experience/hand.md'),
      '# A Note I Wrote\n\nSome prose I typed in Obsidian.\n'
    )

    const read = await wiki.readPage('experience/hand.md')

    expect(read).toEqual({
      path: 'experience/hand.md',
      title: 'A Note I Wrote',
      summary: '',
      body: '# A Note I Wrote\n\nSome prose I typed in Obsidian.'
    })
  })

  test('a hand-written page with no heading falls back to the filename', async () => {
    await mkdir(join(root, 'experience'), { recursive: true })
    await writeFile(join(root, 'experience/scratch.md'), 'just some words\n')

    const read = await wiki.readPage('experience/scratch.md')

    expect(read?.title).toBe('scratch')
    expect(read?.body).toBe('just some words')
  })

  test('an unterminated frontmatter block is read as body, not lost', async () => {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'notes.md'), '---\ntitle: broken\n\nprose\n')

    const read = await wiki.readPage('notes.md')

    expect(read?.body).toBe('---\ntitle: broken\n\nprose')
    expect(read?.title).toBe('notes')
  })

  test('unmodelled frontmatter survives a rewrite', async () => {
    await mkdir(join(root, 'experience'), { recursive: true })
    await writeFile(
      join(root, 'experience/acme.md'),
      [
        '---',
        '# a comment the user left',
        'title: Old Title',
        'tags:',
        '  - interview',
        '  - acme',
        'aliases: [Acme Corp]',
        'summary: old summary',
        '---',
        '',
        'body'
      ].join('\n')
    )

    await wiki.writePage(page({ body: 'new body' }))

    const raw = await readFile(join(root, 'experience/acme.md'), 'utf8')
    expect(raw).toBe(
      [
        '---',
        'title: Acme Payments',
        'summary: Led the ledger rewrite.',
        '# a comment the user left',
        'tags:',
        '  - interview',
        '  - acme',
        'aliases: [Acme Corp]',
        '---',
        '',
        'new body',
        ''
      ].join('\n')
    )
  })

  test('CRLF frontmatter parses', async () => {
    await mkdir(join(root, 'experience'), { recursive: true })
    await writeFile(
      join(root, 'experience/crlf.md'),
      '---\r\ntitle: Windows\r\nsummary: from elsewhere\r\n---\r\n\r\nbody\r\n'
    )

    const read = await wiki.readPage('experience/crlf.md')

    expect(read?.title).toBe('Windows')
    expect(read?.summary).toBe('from elsewhere')
  })

  test('a missing page reads as null', async () => {
    expect(await wiki.readPage('experience/nope.md')).toBeNull()
  })
})

describe('path safety', () => {
  const hostile = [
    '../escape.md',
    '../../escape.md',
    'experience/../../escape.md',
    '/etc/passwd.md',
    join(tmpdir(), 'escape.md'),
    'notes.md/../../escape.md'
  ]

  for (const relPath of hostile) {
    test(`rejects ${relPath}`, async () => {
      await wiki.scaffold()
      const before = await snapshot(directory)

      await expect(wiki.readPage(relPath)).rejects.toThrow(/escapes the wiki root|must be relative/)
      await expect(wiki.writePage(page({ path: relPath }))).rejects.toThrow(
        /escapes the wiki root|must be relative/
      )

      // Nothing was created anywhere, inside the root or above it.
      expect(await snapshot(directory)).toEqual(before)
      expect(await readdir(directory)).toEqual(['vault'])
    })
  }

  test('rejects an empty path, a non-markdown path and a NUL byte', async () => {
    await expect(wiki.readPage('')).rejects.toThrow(/empty/)
    await expect(wiki.writePage(page({ path: '.obsidian/app.json' }))).rejects.toThrow(
      /must end in .md/
    )
    const nul = `notes${String.fromCharCode(0)}.md`
    await expect(wiki.writePage(page({ path: nul }))).rejects.toThrow(/NUL/)
  })

  test('a traversal that lands back inside is normalised, not rejected', async () => {
    await wiki.writePage(page({ path: 'experience/../target/acme.md' }))

    expect((await wiki.readPage('target/acme.md'))?.path).toBe('target/acme.md')
    expect(await wiki.targets()).toEqual(['acme'])
  })
})

describe('listPages', () => {
  test('lists content pages and skips the generated ones', async () => {
    await wiki.scaffold()
    await wiki.writePage(page())
    await wiki.writePage(page({ path: 'target/globex.md' }))

    const paths = (await wiki.listPages()).map((p) => p.path)

    expect(paths).toEqual(['experience/acme.md', 'notes.md', 'profile.md', 'target/globex.md'])
  })

  test('a prefix matches whole segments', async () => {
    await wiki.writePage(page({ path: 'target/globex.md' }))
    await wiki.writePage(page({ path: 'target-notes.md' }))

    expect((await wiki.listPages('target')).map((p) => p.path)).toEqual(['target/globex.md'])
    expect((await wiki.listPages('target/')).map((p) => p.path)).toEqual(['target/globex.md'])
  })

  test('ignores dot directories and non-markdown files', async () => {
    await wiki.scaffold()
    await mkdir(join(root, '.obsidian'), { recursive: true })
    await writeFile(join(root, '.obsidian/app.md'), 'not a page')
    await writeFile(join(root, 'experience/resume.pdf'), 'not a page')

    expect((await wiki.listPages()).map((p) => p.path)).toEqual(['notes.md', 'profile.md'])
  })
})

describe('rebuildIndex', () => {
  test('groups pages by category with wikilinks and summaries', async () => {
    await wiki.scaffold()
    await wiki.writePage(page())
    await wiki.writePage(
      page({ path: 'target/globex.md', title: 'Globex', summary: 'Staff role.' })
    )
    await wiki.writePage(page({ path: 'stories.md', title: 'Stories', summary: '' }))

    await wiki.rebuildIndex()

    const index = await readFile(join(root, 'index.md'), 'utf8')
    expect(index).toContain('Generated from the pages on disk')
    expect(index).toContain('## Experience\n\n- [[experience/acme|Acme Payments]] — Led the ledger')
    expect(index).toContain('## Targets\n\n- [[target/globex|Globex]] — Staff role.')
    expect(index).toContain('## Other\n\n- [[stories|Stories]]')
    expect(index.indexOf('## Profile')).toBeLessThan(index.indexOf('## Experience'))
    expect(index).not.toContain('[[index')
  })

  test('drops entries for deleted pages', async () => {
    await wiki.scaffold()
    await wiki.writePage(page())
    await wiki.rebuildIndex()
    expect(await readFile(join(root, 'index.md'), 'utf8')).toContain('experience/acme')

    await rm(join(root, 'experience/acme.md'))
    await wiki.rebuildIndex()

    expect(await readFile(join(root, 'index.md'), 'utf8')).not.toContain('experience/acme')
  })

  test('is byte stable across rebuilds', async () => {
    await wiki.scaffold()
    await wiki.writePage(page())
    await wiki.rebuildIndex()
    const first = await readFile(join(root, 'index.md'), 'utf8')

    await wiki.rebuildIndex()

    expect(await readFile(join(root, 'index.md'), 'utf8')).toBe(first)
  })

  test('an unscaffolded wiki still gets a valid index', async () => {
    expect(await wiki.listPages()).toEqual([])

    await wiki.rebuildIndex()

    const read = await wiki.readPage('index.md')
    expect(read?.title).toBe('Index')
    expect(read?.body).toContain('No pages yet.')
  })
})

describe('appendLog', () => {
  const at = new Date('2026-07-24T09:05:00Z')

  test('appends dated bullets without touching earlier entries', async () => {
    await wiki.scaffold()

    await wiki.appendLog('ingested resume.pdf (3 sources)', at)
    await wiki.appendLog('lint: 2 pages missing a summary', new Date('2026-07-25T10:00:00Z'))

    const log = await readFile(join(root, 'log.md'), 'utf8')
    expect(log).toContain('- 2026-07-24 09:05 UTC — ingested resume.pdf (3 sources)')
    expect(log).toContain('- 2026-07-25 10:00 UTC — lint: 2 pages missing a summary')
    expect(log.indexOf('ingested')).toBeLessThan(log.indexOf('lint:'))
    expect(log.startsWith('---\ntitle: Log')).toBe(true)
  })

  test('preserves an entry the user edited above it', async () => {
    await wiki.scaffold()
    await wiki.appendLog('first', at)
    await wiki.appendLog('second', at)
    const before = await readFile(join(root, 'log.md'), 'utf8')

    await wiki.appendLog('third', at)

    const after = await readFile(join(root, 'log.md'), 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(before.length)).toBe('- 2026-07-24 09:05 UTC — third\n')
  })

  test('creates the log when it is missing', async () => {
    await wiki.appendLog('before any scaffold', at)

    expect(await readFile(join(root, 'log.md'), 'utf8')).toContain('before any scaffold')
  })

  test('recovers when the file does not end in a newline', async () => {
    await wiki.scaffold()
    await writeFile(join(root, 'log.md'), '- earlier, no trailing newline')

    await wiki.appendLog('next', at)

    expect(await readFile(join(root, 'log.md'), 'utf8')).toBe(
      '- earlier, no trailing newline\n- 2026-07-24 09:05 UTC — next\n'
    )
  })

  test('collapses a multi-line entry into one bullet and ignores an empty one', async () => {
    await wiki.scaffold()

    await wiki.appendLog('two\nlines   here', at)
    await wiki.appendLog('   ', at)

    const bullets = (await readFile(join(root, 'log.md'), 'utf8'))
      .split('\n')
      .filter((line) => line.startsWith('- '))
    expect(bullets).toEqual(['- 2026-07-24 09:05 UTC — two lines here'])
  })
})

describe('targets', () => {
  test('enumerates slugs, sorted', async () => {
    await wiki.scaffold()
    await wiki.writePage(page({ path: 'target/globex.md' }))
    await wiki.writePage(page({ path: 'target/acme-corp.md' }))
    await writeFile(join(root, 'target/notes.txt'), 'ignored')
    await writeFile(join(root, 'target/.DS_Store'), 'ignored')
    await mkdir(join(root, 'target/archive'), { recursive: true })

    expect(await wiki.targets()).toEqual(['acme-corp', 'globex'])
  })

  test('is empty before anything exists', async () => {
    expect(await wiki.targets()).toEqual([])

    await wiki.scaffold()

    expect(await wiki.targets()).toEqual([])
  })
})

describe('atomic writes', () => {
  test('leave no temp file behind', async () => {
    await wiki.scaffold()
    await Promise.all([
      wiki.writePage(page()),
      wiki.writePage(page({ path: 'experience/beta.md' })),
      wiki.rebuildIndex()
    ])

    for (const name of [...(await readdir(root)), ...(await readdir(join(root, 'experience')))]) {
      expect(name.endsWith('.tmp')).toBe(false)
    }
  })

  test('a failed write leaves the previous page intact', async () => {
    if (process.getuid?.() === 0) return // root ignores the mode bits below
    await wiki.scaffold()
    await wiki.writePage(page({ body: 'version one' }))
    await chmod(join(root, 'experience'), 0o500)

    try {
      expect(wiki.writePage(page({ body: 'version two' }))).rejects.toThrow()
    } finally {
      await chmod(join(root, 'experience'), 0o700)
    }

    expect((await wiki.readPage('experience/acme.md'))?.body).toBe('version one')
    expect(await readdir(join(root, 'experience'))).toEqual(['acme.md'])
  })
})

describe('slugify', () => {
  test('lowercases, collapses and trims', () => {
    expect(slugify('  Acme Corp — Payments Platform!  ')).toBe('acme-corp-payments-platform')
    expect(slugify('Staff/Principal (Backend)')).toBe('staff-principal-backend')
  })

  test('folds accents rather than dropping the letter', () => {
    expect(slugify('Café Ops')).toBe('cafe-ops')
  })

  test('never returns something that would become a dotfile', () => {
    expect(slugify('!!!')).toBe('untitled')
    expect(slugify('')).toBe('untitled')
  })

  test('caps the length without a trailing dash', () => {
    const slug = slugify('a very long title '.repeat(20))
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug.endsWith('-')).toBe(false)
  })
})
