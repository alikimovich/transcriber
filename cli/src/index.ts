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

export * from './config.ts'
export * from './interpret.ts'
export * from './prompt.ts'
export * from './providers/index.ts'
export * from './retry.ts'
export * from './settings.ts'
export * from './transcript.ts'
export * from './types.ts'
