---
name: interview
description: Build and maintain the context Interview Lens uses during a live job interview — ingest a resume, job posting, company research or notes into a personal wiki, keep a short briefing current, and start a listening session. Use whenever the user mentions preparing for an interview, adds a resume or job description, asks to research a company they are interviewing with, or wants to start/stop Interview Lens. Triggers on "prep for my interview", "add my resume", "I'm interviewing at X", "update my interview context", "start the interview assistant".
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - WebFetch
  - WebSearch
---

# /interview — build the context, then listen

Interview Lens transcribes a live interview on-device and explains what the
interviewer is probing for. It reads one short file: **the briefing**. Your job
is to build the wiki behind that briefing, and to keep the briefing honest.

Lens itself does no ingestion. You do it — you already read PDFs, fetch pages,
walk folders and write markdown, and you can ask the user questions while you
work, which a subcommand cannot.

## Where things live

```
~/memory/interview-lens/          the wiki (inside the user's Obsidian vault)
  AGENTS.md                       conventions — read this first, it is the schema
  index.md                        generated catalogue; do not hand-edit
  log.md                          append-only record of what was ingested when
  profile.md                      who the candidate is
  experience/<slug>.md            one page per role or substantial project
  target/<slug>.md                one page per company/role being interviewed for
  target/<slug>.briefing.md       ← what Lens actually reads
  notes.md                        the user's own freeform notes
```

Override the location with `INTERVIEW_LENS_WIKI`. Confirm it with
`interview-lens context path`.

## First, check the setup

```sh
interview-lens doctor
```

If the command is missing, Lens is not installed — point the user at
`~/dev/interview-lens/install.sh` and stop. If the wiki does not exist,
`interview-lens context init` scaffolds it.

## Workflow: build or extend the context

The user gives you a resume path, a folder, some links, or just talks. For each
source:

1. **Read it yourself.** `Read` for local files (it handles PDFs), `WebFetch`
   for URLs, `Glob` + `Read` for a folder. Skip binaries and anything unrelated.
2. **Say what you found, briefly**, and ask about anything load-bearing that is
   ambiguous — a role's actual scope, whether a project is worth its own page,
   which of three similar jobs they are actually preparing for. One or two
   questions, not an interrogation.
3. **Write pages** following `AGENTS.md`. Read a page before rewriting it and
   carry forward anything the user wrote that your source does not cover.
4. **Append to `log.md`** — what you ingested, from where, today's date.
5. **Rebuild `index.md`** so every page appears with its one-line summary.
6. **Refresh the briefing** for the active target (below).

## Workflow: a new target

When the user names a company or role they are interviewing for:

```sh
interview-lens target new acme        # creates target/acme.md, makes it active
```

Then research it — the posting, the company's engineering blog, recent news,
the interviewer's background if the user names them — and write
`target/acme.md`. Ask the user what they already know before searching; they
often have context you would otherwise spend three fetches rediscovering.

## Workflow: the briefing

**This is the only file Lens reads, and it is the one that has to be short.**

Write `target/<slug>.briefing.md` as plain markdown, no frontmatter, **under
3000 characters**. Four sections:

```markdown
## Candidate
Two or three sentences: level, domain, the shape of their career.

## Evidence they can draw on
- Cut p99 checkout latency 800ms → 120ms by replacing the pricing cache
- Led the 4-person migration off the monolith; shipped in two quarters
(up to six lines, each a concrete thing they actually did)

## What this role selects for
Two or three sentences, from the posting and your research.

## Likely probing directions
- Thin on formal people management — expect scope questions
(up to four lines)
```

Rules for the briefing, in priority order:

1. **Never invent.** Every line traces to a wiki page. No inferred titles,
   technologies, dates or metrics.
2. **Specifics beat summary.** A number the user actually achieved is worth ten
   lines of "improved performance".
3. **It is sent on every keypress during the interview.** Length is the binding
   constraint — this is why it is not just the wiki concatenated.
4. **Say when something is missing** rather than padding. "No evidence of
   large-team leadership in the wiki" is useful; invented evidence is worse
   than none.

Show the user the briefing when you have written it. It is theirs to edit, and
they will spot a wrong emphasis faster than you will.

## Workflow: lint

Ask for this periodically, or when the wiki has grown:

- claims on two pages that contradict each other
- pages with no inbound links from `index.md`
- stale target pages for interviews that already happened
- a briefing that no longer matches the pages behind it

Report findings; do not silently rewrite. The user decides.

## Workflow: run a session

```sh
interview-lens doctor                    # confirm audio + credentials first
interview-lens run --match zoom          # or --match "Google Chrome" to rehearse
```

Tell the user: **wear headphones** — without them the interviewer's voice
reaches their microphone too and lands on both channels. In the session,
`space` asks for an interpretation, `c` clears, `q` quits.

## Things to get right

- **Never delete the user's prose.** This wiki lives in their vault. If a page
  has writing your source does not cover, keep it verbatim.
- **One role or project per experience page.** Split a source that spans
  several.
- **Use `[[wikilinks]]`** — it is read in Obsidian.
- **Do not put secrets in the wiki.** API keys live in the Keychain; the wiki is
  plain markdown in a synced folder.
- **The wiki is prep, not a script.** Lens interprets questions and never drafts
  answers; do not write "say that you..." material into the briefing.
