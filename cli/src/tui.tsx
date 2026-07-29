// Live terminal UI for a recording session.
//
// Presentational only — it takes plain data and renders. Wiring lives in
// cli.tsx so this stays trivially testable and so the transcript store never has
// to know a UI exists. There is no interpretation layer any more: this just
// shows what is being captured and transcribed as it happens.
//
// Layout note: every row is a fixed-width gutter next to a flexible text
// column. That is what gives wrapped lines a hanging indent — and it is also
// the only reliable way to keep a space between the speaker label and the
// text, because Ink collapses trailing whitespace inside a <Text>.

import { Box, Text, useApp, useInput } from 'ink'
import type { Channel, Turn } from './types.ts'

export interface ViewState {
  target: string
  ready: boolean
  channels: Channel[]
  levels: Record<Channel, { rms: number; peak: number }>
  /** Most recent status message, if any, with its severity. */
  notice?: { text: string; severity: 'info' | 'warn' }
  turns: Turn[]
  elapsedSeconds: number
  /** Epoch seconds at which the session started, for relative timestamps. */
  sessionStartedAt: number
}

export interface TuiProps {
  state: ViewState
  onClear: () => void
  onQuit: () => void
}

const CHANNEL_LABEL: Record<Channel, string> = { me: 'you', them: 'them' }
const CHANNEL_COLOR: Record<Channel, string> = { me: 'green', them: 'cyan' }

/** Width of the timestamp + speaker gutter. Wrapped text aligns to it. */
const GUTTER = 12
const METER_WIDTH = 14

/**
 * A level bar coloured by how hot the signal is. Silence is deliberately
 * visible rather than blank: a channel sitting at zero is the single most
 * common failure, and the user should be able to see it at a glance.
 */
function Meter({ channel, peak }: { channel: Channel; peak: number }) {
  const level = Math.max(0, Math.min(1, peak))
  const filled = Math.round(level * METER_WIDTH)
  const color = level > 0.9 ? 'red' : level > 0.6 ? 'yellow' : level > 0.02 ? 'green' : 'gray'

  return (
    <Box gap={1}>
      <Text color={CHANNEL_COLOR[channel]} bold>
        {CHANNEL_LABEL[channel]}
      </Text>
      <Text color={color}>{'▍'.repeat(filled)}</Text>
      <Text dimColor>{'╌'.repeat(METER_WIDTH - filled)}</Text>
    </Box>
  )
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function Header({ state }: { state: ViewState }) {
  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text color={state.ready ? 'red' : 'yellow'} bold>
          {state.ready ? '●' : '○'} {state.ready ? 'recording' : 'starting…'}
        </Text>
        <Text bold>{clock(state.elapsedSeconds)}</Text>
        <Text dimColor>{state.target}</Text>
      </Box>
      <Box gap={3} marginTop={1}>
        {state.channels.map((c) => (
          <Meter key={c} channel={c} peak={state.levels[c]?.peak ?? 0} />
        ))}
      </Box>
    </Box>
  )
}

/** One transcript line: fixed gutter, then wrapping text aligned under itself. */
function TurnRow({ turn, sessionStartedAt }: { turn: Turn; sessionStartedAt: number }) {
  const stamp = clock(turn.startedAt - sessionStartedAt)
  return (
    <Box>
      <Box width={GUTTER} flexShrink={0}>
        <Text dimColor>{stamp} </Text>
        <Text color={CHANNEL_COLOR[turn.channel]} bold>
          {CHANNEL_LABEL[turn.channel]}
        </Text>
      </Box>
      <Box flexGrow={1}>
        {/* A turn still in flight is dimmed: it may still be revised. */}
        <Text wrap="wrap" dimColor={!turn.isFinal}>
          {turn.text}
        </Text>
      </Box>
    </Box>
  )
}

/** Ink repaints its whole block each frame, so only render a viewport. */
const VISIBLE_TURNS = 10

export function Tui({ state, onClear, onQuit }: TuiProps) {
  const { exit } = useApp()

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      onQuit()
      exit()
      return
    }
    if (input === 'c') onClear()
  })

  const visible = state.turns.slice(-VISIBLE_TURNS)
  const hidden = state.turns.length - visible.length
  const words = state.turns.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0)

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
      <Header state={state} />

      {state.notice ? (
        <Box>
          <Text color={state.notice.severity === 'warn' ? 'yellow' : 'gray'}>
            {state.notice.severity === 'warn' ? '! ' : '· '}
            {state.notice.text}
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column">
        {hidden > 0 ? <Text dimColor>… {hidden} earlier turn(s), all saved</Text> : null}
        {visible.length === 0 ? (
          <Text dimColor>listening — nothing transcribed yet</Text>
        ) : (
          visible.map((turn) => (
            <TurnRow
              key={`${turn.channel}-${turn.startedAt}-${turn.endedAt}`}
              turn={turn}
              sessionStartedAt={state.sessionStartedAt}
            />
          ))
        )}
      </Box>

      <Box gap={2}>
        <Text dimColor>
          <Text bold>q</Text> save & quit
        </Text>
        <Text dimColor>
          <Text bold>c</Text> clear
        </Text>
        {words > 0 ? <Text dimColor>· {words} words</Text> : null}
      </Box>
    </Box>
  )
}
