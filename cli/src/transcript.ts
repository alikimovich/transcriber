/**
 * Assembly of `tcapture` transcript events into channel-labelled turns.
 *
 * Pure and synchronous: no I/O, no timers, no globals. The only outside value it
 * reads is `Date.now()` in `window()`, and that is injectable.
 *
 * ## Why this is not a string concatenation
 *
 * The speech analyzer emits two kinds of result. A *volatile* result is a guess
 * about the utterance in flight; a later result covering the same span replaces
 * it. A *finalized* result never changes and is identified by its `start` on the
 * audio timeline. Crucially, a volatile result is **not** guaranteed to be
 * reissued as final, so dropping volatiles loses speech, and appending them
 * duplicates it. The store therefore keeps, per channel, an ordered list of
 * finalized segments plus at most one live volatile segment.
 *
 * ## Clocks
 *
 * `start`/`end` on a transcript event are seconds on that channel's *own* audio
 * timeline, and the two channels' analyzers start at slightly different moments.
 * To interleave them — and to answer "was this said in the last 30 seconds?" —
 * the store estimates, per channel, the epoch time of audio-time zero as
 * `min(t - end)` over every result seen. Emit latency makes any single sample an
 * over-estimate, so the minimum is the tightest available bound, and it is
 * applied at read time so that later refinements correct earlier turns.
 */

import {
  type CaptureEvent,
  CHANNELS,
  type Channel,
  type ReadyEvent,
  type StatusEvent,
  statusChannel,
  type TranscriptEvent,
  type Turn
} from './types.ts'

/** Tolerance for comparing audio-timeline positions, in seconds. */
const EPSILON = 1e-6

type Segment = {
  /** Audio-timeline start, and the identity of a finalized result. */
  start: number
  end: number
  text: string
  /** Epoch seconds at which the result was emitted. */
  t: number
  /** Insertion order, used only as a stable sort tiebreaker. */
  seq: number
  /**
   * True for a volatile segment that was retired into the finalized list because
   * the speaker moved on without it ever being finalized. Its text is settled,
   * but a real finalized result for the same span may still replace it.
   */
  promoted: boolean
}

type ChannelSlot = {
  /** Finalized segments, ascending by `start`. Keyed by `start` on upsert. */
  finals: Segment[]
  /** The single result in flight, or null. */
  live: Segment | null
  /** Epoch seconds corresponding to audio time zero. */
  offset: number | null
  level: LevelSample | null
  status: StatusEvent | null
}

export type LevelSample = {
  rms: number
  peak: number
  /** Epoch seconds at which the level was measured. */
  t: number
}

export type ChannelState = {
  level: LevelSample | null
  /** The most recent status event attributable to this channel. */
  status: StatusEvent | null
}

export type TranscriptStoreOptions = {
  /**
   * When a new utterance begins while the previous one is still volatile, keep
   * the abandoned text by moving it into the finalized list instead of dropping
   * it. A genuine finalized result for the same span replaces it later, because
   * finalized segments are keyed by `start`.
   *
   * Defaults to true: losing something a speaker actually said is worse than the
   * small risk of duplication if the analyzer re-segments an utterance.
   */
  keepAbandonedVolatiles?: boolean
}

export class TranscriptStore {
  private readonly slots: Record<Channel, ChannelSlot>
  private readonly keepAbandonedVolatiles: boolean
  private seq = 0
  /**
   * Turns from before a helper restart, already projected onto the wall clock.
   *
   * A restart resets the audio timelines, so live segments can't be carried
   * across it — but their wall-clock projections are already settled and can.
   * They must be: a restart once fired mid-call and silently destroyed two and
   * a half minutes of recorded conversation. Frozen turns only ever grow and
   * are only dropped by an explicit clear().
   */
  private frozen: Turn[] = []

  /** The most recent status event, whichever channel it concerns. */
  lastStatus: StatusEvent | null = null
  /** The `ready` event for the current capture session, if one has arrived. */
  session: ReadyEvent | null = null
  /** Set when the helper reports it has stopped. */
  stoppedReason: 'signal' | 'duration' | null = null
  /** Bumped on every accepted event. Cheap change detection for a renderer. */
  revision = 0
  /** Bumped only when transcript text changes, so level noise does not trigger work. */
  transcriptRevision = 0

  constructor(options: TranscriptStoreOptions = {}) {
    this.keepAbandonedVolatiles = options.keepAbandonedVolatiles ?? true
    this.slots = {
      me: emptySlot(),
      them: emptySlot()
    }
  }

  /**
   * Fold one capture event into the store. Unknown event types are ignored so a
   * newer helper cannot break an older CLI.
   */
  applyEvent(e: CaptureEvent): void {
    switch (e.type) {
      case 'ready':
        this.applyReady(e)
        break
      case 'transcript':
        this.applyTranscript(e)
        break
      case 'level':
        this.slots[e.channel].level = { rms: e.rms, peak: e.peak, t: e.t }
        break
      case 'status':
        this.applyStatus(e)
        break
      case 'stopped':
        this.stoppedReason = e.reason
        break
      default:
        return
    }
    this.revision += 1
  }

  /**
   * Turns overlapping the last `seconds`, oldest first, with consecutive
   * same-channel segments merged into one turn.
   *
   * A turn is included when any part of it falls inside the window; it is not
   * clipped. Pass `Number.POSITIVE_INFINITY` for the whole session. `now` is
   * epoch seconds and defaults to the wall clock, because event timestamps are
   * epoch seconds too.
   */
  window(seconds: number, now: number = Date.now() / 1000): Turn[] {
    if (!(seconds > 0)) return []
    const cutoff = seconds === Number.POSITIVE_INFINITY ? Number.NEGATIVE_INFINITY : now - seconds

    const projected: { turn: Turn; seq: number }[] = []
    // Frozen turns predate every live segment, so negative pseudo-seqs keep
    // their original order as the sort tiebreaker.
    this.frozen.forEach((turn, i) => {
      if (turn.endedAt >= cutoff) projected.push({ turn, seq: i - this.frozen.length })
    })
    for (const channel of CHANNELS) {
      for (const segment of this.segmentsOf(channel)) {
        const turn = this.project(channel, segment)
        if (turn.endedAt >= cutoff) projected.push({ turn, seq: segment.seq })
      }
    }

    projected.sort((a, b) => {
      if (a.turn.startedAt !== b.turn.startedAt) return a.turn.startedAt - b.turn.startedAt
      if (a.turn.endedAt !== b.turn.endedAt) return a.turn.endedAt - b.turn.endedAt
      return a.seq - b.seq
    })

    return mergeAdjacent(projected.map((p) => p.turn))
  }

  /** The full transcript per channel, for display. */
  render(): { me: string; them: string } {
    return {
      me: this.renderChannel('me'),
      them: this.renderChannel('them')
    }
  }

  /** Live audio level and the last status attributed to a channel. */
  state(channel: Channel): ChannelState {
    const slot = this.slots[channel]
    return { level: slot.level, status: slot.status }
  }

  /**
   * Drop all transcript state — the live segments, the audio-clock estimates,
   * and the frozen turns from before any restart. Levels, statuses and session
   * info are kept: they describe the live stream rather than the transcript.
   * Construct a new store for a genuinely new session.
   */
  clear(): void {
    this.frozen = []
    this.resetTimelines()
  }

  // -------------------------------------------------------------------------

  /** Forget the current audio timelines without touching the frozen archive. */
  private resetTimelines(): void {
    for (const channel of CHANNELS) {
      const slot = this.slots[channel]
      slot.finals = []
      slot.live = null
      slot.offset = null
    }
    this.revision += 1
    this.transcriptRevision += 1
  }

  private applyReady(e: ReadyEvent): void {
    // A second `ready` means the helper restarted: the audio timelines have
    // reset to zero, so live segments can't be carried over as segments. Their
    // wall-clock projections are settled, though — archive them. Losing them
    // instead once cost a session its first two and a half minutes.
    if (this.session !== null) {
      this.frozen = this.window(Number.POSITIVE_INFINITY)
      this.resetTimelines()
      this.stoppedReason = null
    }
    this.session = e
  }

  private applyStatus(e: StatusEvent): void {
    this.lastStatus = e
    const channel = statusChannel(e.code)
    if (channel !== null) this.slots[channel].status = e
  }

  private applyTranscript(e: TranscriptEvent): void {
    const text = e.text.trim()
    if (text === '') return

    const slot = this.slots[e.channel]
    this.refineOffset(slot, e)

    const segment: Segment = {
      start: e.start,
      end: Math.max(e.start, e.end),
      text,
      t: e.t,
      seq: this.seq++,
      promoted: false
    }

    if (e.isFinal) {
      // A retired volatile that covered mostly this same audio was a guess at
      // the same speech; the authoritative version supersedes it. `upsertFinal`
      // already handles the case where the two agree on `start` exactly — this
      // catches the case where the analyzer nudged the boundary, which would
      // otherwise leave the guess and the real thing sitting side by side.
      slot.finals = slot.finals.filter((s) => !s.promoted || !mostlyCoveredBy(s, segment))
      upsertFinal(slot.finals, segment)
      // Anything the live segment covered up to this point is now finalized.
      if (slot.live !== null && slot.live.start < segment.end - EPSILON) slot.live = null
    } else {
      // Discard a stale volatile whose audio has already been finalized.
      const finalizedThrough = slot.finals.reduce(
        (max, s) => Math.max(max, s.end),
        Number.NEGATIVE_INFINITY
      )
      if (segment.end <= finalizedThrough + EPSILON) return

      const previous = slot.live
      if (
        this.keepAbandonedVolatiles &&
        previous !== null &&
        segment.start > previous.start + EPSILON
      ) {
        // The speaker moved on and this utterance was never finalized. Its text
        // will not change again, so treat it as settled while remembering that
        // a real finalized result may still replace it.
        upsertFinal(slot.finals, { ...previous, promoted: true })
      }
      slot.live = segment
    }

    this.transcriptRevision += 1
  }

  /**
   * Tighten the estimate of when audio time zero happened. The result was
   * emitted at `t` after the audio at `end` was consumed, so `t - end` is an
   * upper bound on the true offset; the smallest bound seen wins.
   */
  private refineOffset(slot: ChannelSlot, e: TranscriptEvent): void {
    const candidate = e.t - e.end
    if (!Number.isFinite(candidate) || candidate <= 0) return
    slot.offset = slot.offset === null ? candidate : Math.min(slot.offset, candidate)
  }

  /** Every segment of a channel, ascending by audio-timeline start. */
  private segmentsOf(channel: Channel): Segment[] {
    const slot = this.slots[channel]
    if (slot.live === null) return slot.finals
    const all = [...slot.finals, slot.live]
    all.sort((a, b) => a.start - b.start || a.seq - b.seq)
    return all
  }

  private project(channel: Channel, segment: Segment): Turn {
    const slot = this.slots[channel]
    // Falling back to the segment's own emit time keeps projection total even if
    // the offset was rejected as implausible.
    const offset = slot.offset ?? segment.t - segment.end
    return {
      channel,
      text: segment.text,
      startedAt: offset + segment.start,
      endedAt: offset + segment.end,
      // Only the one segment still in flight is unsettled; a promoted volatile
      // has been retired into the finalized list and will not change again.
      isFinal: slot.live !== segment
    }
  }

  private renderChannel(channel: Channel): string {
    const frozen = this.frozen.filter((t) => t.channel === channel).map((t) => t.text)
    const live = this.segmentsOf(channel).map((s) => s.text)
    return [...frozen, ...live].filter((t) => t !== '').join(' ')
  }
}

function emptySlot(): ChannelSlot {
  return { finals: [], live: null, offset: null, level: null, status: null }
}

/**
 * Whether `span` accounts for most of `segment`'s audio.
 *
 * Deliberately not a containment test and deliberately not bare overlap. Two
 * results for the same utterance can disagree slightly about both boundaries, so
 * containment misses them; but a finalized result for the *next* utterance can
 * also clip the previous one by a few milliseconds, and bare overlap would throw
 * away a whole abandoned question on the strength of that.
 */
function mostlyCoveredBy(segment: Segment, span: { start: number; end: number }): boolean {
  const overlap = Math.min(segment.end, span.end) - Math.max(segment.start, span.start)
  if (overlap <= 0) return false
  return overlap >= (segment.end - segment.start) / 2
}

/**
 * Insert a finalized segment, replacing any existing one with the same `start`.
 * Finalized results are identified by their start time, so a reissue of the same
 * span is a correction rather than new speech.
 */
function upsertFinal(finals: Segment[], segment: Segment): void {
  for (let i = 0; i < finals.length; i++) {
    const existing = finals[i]
    if (existing === undefined) continue
    if (Math.abs(existing.start - segment.start) <= EPSILON) {
      finals[i] = segment
      return
    }
    if (existing.start > segment.start) {
      finals.splice(i, 0, segment)
      return
    }
  }
  finals.push(segment)
}

/** Fold runs of same-channel turns into one turn each. */
function mergeAdjacent(turns: Turn[]): Turn[] {
  const merged: Turn[] = []
  for (const turn of turns) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && previous.channel === turn.channel) {
      previous.text = `${previous.text} ${turn.text}`
      previous.endedAt = Math.max(previous.endedAt, turn.endedAt)
      previous.isFinal = previous.isFinal && turn.isFinal
    } else {
      merged.push({ ...turn })
    }
  }
  return merged
}
