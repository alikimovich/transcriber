/**
 * Public surface of the Interview Lens core.
 *
 * A consumer — the TUI, the MCP server — should need nothing beyond this:
 *
 * ```ts
 * const store = new TranscriptStore()
 * for await (const line of lines) {
 *   const event = parseEvent(line)
 *   if (event !== null) store.applyEvent(event)
 * }
 * const result = await interpret({ context: await loadContext(), turns: store.window(60) })
 * ```
 */

export * from './config'
export * from './openai'
export * from './prompt'
export * from './transcript'
export * from './types'
