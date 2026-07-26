// Live terminal UI.
//
// Presentational only — it takes plain data and renders. Wiring lives in
// index.ts so this stays trivially testable and so the transcript store never
// has to know a UI exists.

import { Box, Text, useApp, useInput } from 'ink'
import type { Channel, Interpretation, Turn } from './types.ts'

export interface ViewState {
  target: string
  ready: boolean
  channels: Channel[]
  levels: Record<Channel, { rms: number; peak: number }>
  /** Most recent status message, if any, with its severity. */
  notice?: { text: string; severity: 'info' | 'warn' }
  turns: Turn[]
  hint?: Interpretation
  hintPending: boolean
  hintError?: string
  elapsedSeconds: number
}

export interface TuiProps {
  state: ViewState
  onInterpret: () => void
  onClear: () => void
  onQuit: () => void
}

const CHANNEL_LABEL: Record<Channel, string> = {
  interviewer: 'THEM',
  candidate: 'YOU '
}

const CHANNEL_COLOR: Record<Channel, string> = {
  interviewer: 'cyan',
  candidate: 'gray'
}

function meter(peak: number, width = 12): string {
  const filled = Math.round(Math.max(0, Math.min(1, peak)) * width)
  return '█'.repeat(filled) + '·'.repeat(width - filled)
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function StatusBar({ state }: { state: ViewState }) {
  return (
    <Box justifyContent="space-between">
      <Box gap={2}>
        <Text color={state.ready ? 'green' : 'yellow'}>
          {state.ready ? '● live' : '○ starting'}
        </Text>
        <Text dimColor>{state.target}</Text>
        <Text dimColor>{clock(state.elapsedSeconds)}</Text>
      </Box>
      <Box gap={2}>
        {state.channels.map((c) => (
          <Text key={c} color={CHANNEL_COLOR[c]}>
            {CHANNEL_LABEL[c].trim()} {meter(state.levels[c]?.peak ?? 0)}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

function HintPanel({ state }: { state: ViewState }) {
  if (state.hintPending) {
    return (
      <Box borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow">reading the room…</Text>
      </Box>
    )
  }
  if (state.hintError) {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1}>
        <Text color="red">{state.hintError}</Text>
      </Box>
    )
  }
  if (!state.hint) return null

  const { intent, emphasis, clarification, confidence } = state.hint
  const confidenceColor =
    confidence === 'high' ? 'green' : confidence === 'medium' ? 'yellow' : 'red'

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Box>
        <Text color="magenta" bold>
          Likely testing{'  '}
        </Text>
        <Text>{intent}</Text>
      </Box>
      <Box>
        <Text color="magenta" bold>
          Emphasize{'     '}
        </Text>
        <Text>{emphasis}</Text>
      </Box>
      {clarification ? (
        <Box>
          <Text color="magenta" bold>
            Clarify{'       '}
          </Text>
          <Text italic>"{clarification}"</Text>
        </Box>
      ) : null}
      <Text color={confidenceColor} dimColor>
        confidence: {confidence}
      </Text>
    </Box>
  )
}

/** Ink repaints its whole block each frame, so only render a viewport. */
const VISIBLE_TURNS = 8

export function Tui({ state, onInterpret, onClear, onQuit }: TuiProps) {
  const { exit } = useApp()

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      onQuit()
      exit()
      return
    }
    if (input === ' ' || input === 'i') onInterpret()
    if (input === 'c') onClear()
  })

  const visible = state.turns.slice(-VISIBLE_TURNS)

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <StatusBar state={state} />

      {state.notice ? (
        <Text color={state.notice.severity === 'warn' ? 'yellow' : 'gray'}>
          {state.notice.text}
        </Text>
      ) : null}

      <Box flexDirection="column">
        {visible.length === 0 ? (
          <Text dimColor>waiting for speech…</Text>
        ) : (
          visible.map((turn) => (
            <Box key={`${turn.channel}-${turn.startedAt}-${turn.endedAt}`}>
              <Text color={CHANNEL_COLOR[turn.channel]} bold>
                {CHANNEL_LABEL[turn.channel]}{' '}
              </Text>
              <Text wrap="wrap" dimColor={!turn.isFinal}>
                {turn.text}
              </Text>
            </Box>
          ))
        )}
      </Box>

      <HintPanel state={state} />

      <Text dimColor>space interpret · c clear · q quit</Text>
    </Box>
  )
}
