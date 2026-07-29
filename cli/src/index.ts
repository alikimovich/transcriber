/**
 * Public surface of the Interview Lens core.
 *
 * A consumer assembles capture events into turns and saves them as a session:
 *
 * ```ts
 * const store = new TranscriptStore()
 * for await (const line of lines) {
 *   const event = parseEvent(line)
 *   if (event !== null) store.applyEvent(event)
 * }
 * const conversations = new ConversationStore()
 * const session = await conversations.createSession({ title: 'Standup' })
 * // …capture into `session.audioPath`…
 * await conversations.finalize(session, {
 *   turns: store.window(Number.POSITIVE_INFINITY),
 *   endedAt: new Date(),
 *   source: 'all system audio',
 *   channels: ['me', 'them'],
 *   sampleRate: store.session?.sampleRate ?? null
 * })
 * ```
 */

export * from './store.ts'
export * from './transcript.ts'
export * from './types.ts'
