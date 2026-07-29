// Live terminal UI for a recording session.
//
// Presentational only — it takes plain data and renders. Wiring lives in
// cli.tsx so this stays trivially testable and so the transcript store never has
// to know a UI exists. There is no interpretation layer any more: this just
// shows what is being captured and transcribed as it happens.

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
}

export interface TuiProps {
  state: ViewState
  onClear: () => void
  onQuit: () => void
}

const CHANNEL_LABEL: Record<Channel, string> = {
  me: 'ME  ',
  them: 'THEM'
}

const CHANNEL_COLOR: Record<Channel, string> = {
  me: 'gray',
  them: 'cyan'
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
        <Text color={state.ready ? 'red' : 'yellow'}>
          {state.ready ? '● recording' : '○ starting'}
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

/** Ink repaints its whole block each frame, so only render a viewport. */
const VISIBLE_TURNS = 12

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

      <Text dimColor>c clear · q save & quit</Text>
    </Box>
  )
}
