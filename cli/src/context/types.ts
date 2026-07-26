// Types shared by the context pipeline.
//
// Three layers, following the LLM-wiki pattern:
//
//   sources  immutable, extracted to text, never edited
//   wiki     LLM-maintained markdown, lives in the user's Obsidian vault and is
//            theirs to edit by hand
//   compiled a few hundred tokens distilled from the wiki — the only part that
//            actually goes into a hint request
//
// The compile step is the one addition to the pattern. A hint has a ~2s budget;
// sending a whole resume and a company research page on every keypress would
// blow both the latency and the prompt cache.

/** A raw source, already converted to text. */
export type ExtractedSource = {
  /** Stable slug derived from the origin, e.g. `resume-2026-07`. */
  id: string
  /** Original path or URL, kept so a page can cite where a claim came from. */
  origin: string
  kind: 'file' | 'url'
  title: string
  text: string
  /** Size of the extracted text, for reporting and budget decisions. */
  characters: number
  fetchedAt: string
}

export type ExtractError = {
  origin: string
  reason: string
}

export type ExtractOutcome = {
  sources: ExtractedSource[]
  /** Non-fatal: a folder with one unreadable PDF should still ingest the rest. */
  errors: ExtractError[]
}

/** One markdown page in the wiki. */
export type WikiPage = {
  /** Path relative to the wiki root, e.g. `experience/acme.md`. */
  path: string
  title: string
  /** One line, used verbatim in index.md. */
  summary: string
  body: string
}

export type WikiLayout = {
  root: string
  indexPath: string
  logPath: string
  schemaPath: string
}

/** What actually reaches the model on a hint request. */
export type CompiledContext = {
  /** Rendered markdown, budget-capped. */
  text: string
  /** Which target it was compiled for, when one is active. */
  target: string | null
  /** Wiki pages that fed it, for `context show` to explain itself. */
  sourcePages: string[]
  compiledAt: string
  characters: number
}

/**
 * Rough budget for the compiled context. Deliberately small: this is prepended
 * to every hint request, ahead of the transcript window.
 */
export const COMPILED_CONTEXT_CHAR_BUDGET = 4000
