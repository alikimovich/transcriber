#!/usr/bin/env bun
// interview-lens — entry point.
//
//   record   listen to mic + system audio, transcribe on-device, save a session
//   doctor   check the capture helper, audio, and the conversation store

import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { render } from 'ink'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { ConversationStore, conversationsRoot } from './store.ts'
import { CaptureSupervisor, type CaptureTarget } from './supervisor.ts'
import { TranscriptStore } from './transcript.ts'
import { Tui, type ViewState } from './tui.tsx'
import type { Channel } from './types.ts'

const CAPTURE_BINARY = resolve(import.meta.dirname, '../../capture/ilcapture')

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  return undefined
}

function parseTarget(argv: string[]): CaptureTarget {
  const match = flagValue(argv, '--match')
  if (match !== undefined) return { kind: 'match', text: match }

  const pids = argv
    .flatMap((a, i) => (a === '--pid' ? [argv[i + 1]] : []))
    .filter((v): v is string => Boolean(v))
    .map(Number)
    .filter((n) => Number.isFinite(n))
  if (pids.length) return { kind: 'process', pids }
  if (argv.includes('--all')) return { kind: 'all' }

  fail(
    'Pick what to listen to:\n' +
      '  --match zoom      capture just the app whose name matches\n' +
      '  --pid 1234        capture just this process\n' +
      '  --all             capture all system output\n\n' +
      '`interview-lens doctor` lists what is currently producing audio.'
  )
}

/** The "listening to …" line shown in the live view. */
function describeTarget(target: CaptureTarget): string {
  switch (target.kind) {
    case 'match':
      return `listening to ${target.text}`
    case 'process':
      return `listening to pid ${target.pids.join(', ')}`
    case 'all':
      return 'listening to all system audio'
  }
}

/** The short capture-source label persisted to the transcript and meta.json. */
function describeSource(target: CaptureTarget): string {
  switch (target.kind) {
    case 'match':
      return target.text
    case 'process':
      return `pid ${target.pids.join(', ')}`
    case 'all':
      return 'all system audio'
  }
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

function App({
  target,
  useMic,
  recordPath,
  store,
  startedAt
}: {
  target: CaptureTarget
  useMic: boolean
  recordPath: string
  store: TranscriptStore
  startedAt: number
}) {
  const supervisorRef = useRef<CaptureSupervisor | null>(null)

  const [, forceRender] = useState(0)
  const initialChannels: Channel[] = useMic ? ['me', 'them'] : ['them']
  const [state, setState] = useState<ViewState>({
    target: describeTarget(target),
    ready: false,
    channels: initialChannels,
    levels: {
      me: { rms: 0, peak: 0 },
      them: { rms: 0, peak: 0 }
    },
    turns: [],
    elapsedSeconds: 0
  })

  useEffect(() => {
    const supervisor = new CaptureSupervisor({
      binaryPath: CAPTURE_BINARY,
      target,
      useMic,
      recordPath
    })
    supervisorRef.current = supervisor

    supervisor.on('event', (event) => {
      store.applyEvent(event)
      setState((prev) => {
        const next = { ...prev }
        if (event.type === 'ready') {
          next.ready = true
          next.channels = event.channels
        }
        if (event.type === 'level') {
          next.levels = {
            ...prev.levels,
            [event.channel]: { rms: event.rms, peak: event.peak }
          }
        }
        if (event.type === 'status') {
          next.notice = { text: event.message, severity: 'warn' }
        }
        next.turns = store.window(Number.POSITIVE_INFINITY)
        return next
      })
    })

    supervisor.on('restarting', (attempt, max) =>
      setState((prev) => ({
        ...prev,
        ready: false,
        notice: {
          text: `system audio came up silent — restarting capture (${attempt}/${max})`,
          severity: 'warn'
        }
      }))
    )

    supervisor.on('gaveUp', () =>
      setState((prev) => ({
        ...prev,
        notice: {
          text:
            'system audio is still silent. Check Privacy & Security → ' +
            'Screen & System Audio Recording, or confirm the app is playing sound.',
          severity: 'warn'
        }
      }))
    )

    supervisor.start()

    const ticker = setInterval(() => {
      setState((prev) => ({
        ...prev,
        elapsedSeconds: (Date.now() - startedAt) / 1000
      }))
      forceRender((n) => n + 1)
    }, 1000)

    return () => {
      clearInterval(ticker)
      supervisor.stop()
    }
  }, [target, useMic, recordPath, store, startedAt])

  const onClear = useCallback(() => {
    store.clear()
    setState((prev) => ({
      ...prev,
      turns: [],
      notice: { text: 'transcript cleared', severity: 'info' }
    }))
  }, [store])

  const onQuit = useCallback(() => {
    supervisorRef.current?.stop()
  }, [])

  return React.createElement(Tui, { state, onClear, onQuit })
}

async function runRecord(argv: string[]): Promise<void> {
  const target = parseTarget(argv)
  const useMic = !argv.includes('--no-mic')
  const title = flagValue(argv, '--title')

  const conversations = new ConversationStore()
  const session = await conversations.createSession(title ? { title } : {})
  const store = new TranscriptStore()

  const { waitUntilExit } = render(
    React.createElement(App, {
      target,
      useMic,
      recordPath: session.audioPath,
      store,
      startedAt: session.startedAt.getTime()
    })
  )
  await waitUntilExit()

  // `store.session` reflects what the helper actually delivered; fall back to
  // the requested channels if it never got as far as a `ready`.
  const channels: Channel[] = store.session?.channels ?? (useMic ? ['me', 'them'] : ['them'])
  await conversations.finalize(session, {
    turns: store.window(Number.POSITIVE_INFINITY),
    endedAt: new Date(),
    source: describeSource(target),
    channels,
    sampleRate: store.session?.sampleRate ?? null
  })

  process.stdout.write(`saved ${session.dir}\n`)
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function runDoctor(): Promise<void> {
  const out = (s: string) => process.stdout.write(`${s}\n`)
  let problems = 0
  const bad = (s: string) => {
    problems += 1
    out(`  ✗ ${s}`)
  }
  const good = (s: string) => out(`  ✓ ${s}`)

  out('capture helper')
  const version = spawnSync(CAPTURE_BINARY, ['list'], { encoding: 'utf8' })
  if (version.error) {
    bad(`not found or not runnable at ${CAPTURE_BINARY} — run capture/build.sh`)
  } else {
    good(CAPTURE_BINARY)
    const outputting = (version.stderr ?? '').split('\n').filter((l) => l.includes('▶'))
    out(
      outputting.length
        ? `  ${outputting.length} process(es) producing audio:`
        : // isRunningOutput lags playback by a second or two, so an empty list
          // here is not evidence of a problem — the probe below is.
          '  no app is flagged as producing audio yet (this lags a second or two)'
    )
    for (const line of outputting.slice(0, 8)) out(`    ${line.trim()}`)
  }

  out('')
  out('conversation store')
  try {
    const root = await new ConversationStore().ensureRoot()
    good(`writable at ${root}`)
  } catch (error) {
    bad(`cannot write to ${conversationsRoot()} — ${(error as Error).message}`)
  }

  out('')
  out('audio capture (probing all system output)')

  /** One capture attempt. Resolves with the loudest peak it saw. */
  const probeOnce = (): Promise<{ peak: number; status: string | null }> =>
    new Promise((done) => {
      const child = spawn(
        CAPTURE_BINARY,
        ['capture', '--system-all', '--no-mic', '--seconds', '3'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let peak = 0
      let status: string | null = null
      child.stdout.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (!line.trim()) continue
          try {
            const e = JSON.parse(line)
            if (e.type === 'level' && e.peak > peak) peak = e.peak
            if (e.type === 'status') status = e.code
          } catch {
            /* partial line; readline-free parsing is fine for a one-shot probe */
          }
        }
      })
      child.on('close', () => done({ peak, status }))
    })

  // The tap comes up silent on roughly one launch in three, and a fresh process
  // recovers. Probing once would tell a third of users their permissions are
  // broken when they are fine — worse than not checking at all.
  let probe = await probeOnce()
  if (probe.peak === 0 && probe.status === 'system_audio_silent') {
    out('  first probe came up silent, retrying…')
    probe = await probeOnce()
  }

  if (probe.peak > 0) {
    good(`system audio flowing (peak ${probe.peak.toFixed(3)})`)
  } else if (probe.status === 'system_audio_silent') {
    bad(
      'system audio is silent across two attempts — if something was playing, ' +
        'grant Screen & System Audio Recording in System Settings > Privacy & Security'
    )
  } else {
    out('  – no audio detected (play something and re-run to test properly)')
  }

  out('')
  out(problems === 0 ? 'all good' : `${problems} problem(s) found`)
  process.exit(problems === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2)
  switch (command) {
    case 'record':
      return runRecord(argv)
    case 'doctor':
      return runDoctor()
    default:
      process.stdout.write(
        'interview-lens — record a conversation and save it as a transcript\n\n' +
          '  record    listen and save a session (--match zoom | --pid N | --all)\n' +
          '              --no-mic        system audio only, skip the microphone\n' +
          '              --title "text"  name the session (used in the folder + transcript)\n' +
          '  doctor    check the capture helper, audio, and the conversation store\n\n' +
          `Sessions are saved under ${conversationsRoot()}\n`
      )
      process.exit(command ? 64 : 0)
  }
}

await main()
