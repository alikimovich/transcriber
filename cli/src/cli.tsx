#!/usr/bin/env bun
// transcriber — entry point.
//
//   record   listen to mic + system audio, transcribe on-device, save a session
//   doctor   check the capture helper, audio, and the conversation store

import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from 'ink'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { ConversationStore, conversationsRoot, SessionLog } from './store.ts'
import { CaptureSupervisor, type CaptureTarget, captureBinaryPath } from './supervisor.ts'
import { TranscriptStore } from './transcript.ts'
import { Tui, type ViewState } from './tui.tsx'
import type { CaptureEvent, Channel } from './types.ts'

const CAPTURE_BINARY = captureBinaryPath()

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/** The repo's short git rev, or "unknown" outside a repo / without git. */
function repoRevision(): string {
  const result = spawnSync(
    'git',
    ['-C', resolve(import.meta.dirname, '../..'), 'rev-parse', '--short', 'HEAD'],
    { encoding: 'utf8' }
  )
  const rev = result.status === 0 ? result.stdout.trim() : ''
  return rev || 'unknown'
}

/** When the helper binary was built, or "missing" if it isn't there. */
function binaryMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return 'missing'
  }
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
      '`transcriber doctor` lists what is currently producing audio.'
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
  startedAt,
  log
}: {
  target: CaptureTarget
  useMic: boolean
  recordPath: string
  store: TranscriptStore
  startedAt: number
  log: SessionLog
}) {
  const supervisorRef = useRef<CaptureSupervisor | null>(null)
  // Peak level per channel since the last log summary, so the log carries a
  // coarse signal-over-time trace without a line per level event.
  const peakSinceLog = useRef<Record<Channel, number>>({ me: 0, them: 0 })

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
    elapsedSeconds: 0,
    sessionStartedAt: startedAt / 1000
  })

  useEffect(() => {
    const supervisor = new CaptureSupervisor({
      binaryPath: CAPTURE_BINARY,
      target,
      useMic,
      recordPath
    })
    supervisorRef.current = supervisor

    supervisor.on('event', (event: CaptureEvent) => {
      store.applyEvent(event)
      if (event.type === 'ready') {
        log.append(
          `ready: ${event.sampleRate} Hz, channels [${event.channels.join(', ')}], locale ${event.locale}`
        )
      }
      if (event.type === 'status') log.append(`status ${event.code}: ${event.message}`)
      if (event.type === 'stopped') log.append(`helper stopped (${event.reason})`)
      if (event.type === 'level' && event.peak > peakSinceLog.current[event.channel]) {
        peakSinceLog.current[event.channel] = event.peak
      }
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

    // The helper's stderr carries its diagnostics: audio formats, tap timing,
    // what is being tapped. That is exactly what explains a bad recording, so
    // it all goes in the log verbatim.
    supervisor.on('stderr', (line) => log.append(`helper: ${line}`))
    supervisor.on('exit', (code) => log.append(`helper exited unexpectedly (code ${code})`))

    supervisor.on('restarting', (attempt, max) => {
      log.append(`system audio came up silent — restarting capture (${attempt}/${max})`)
      setState((prev) => ({
        ...prev,
        ready: false,
        notice: {
          text: `system audio came up silent — restarting capture (${attempt}/${max})`,
          severity: 'warn'
        }
      }))
    })

    supervisor.on('gaveUp', () => {
      log.append('gave up restarting: system audio still silent after all attempts')
      setState((prev) => ({
        ...prev,
        notice: {
          text:
            'system audio is still silent. Check Privacy & Security → ' +
            'Screen & System Audio Recording, or confirm the app is playing sound.',
          severity: 'warn'
        }
      }))
    })

    supervisor.start()

    let ticks = 0
    const ticker = setInterval(() => {
      // A coarse level trace every 15s: enough to see when a channel went
      // quiet without drowning the log in level events.
      ticks += 1
      if (ticks % 15 === 0) {
        const p = peakSinceLog.current
        log.append(`levels (15s peak): me ${p.me.toFixed(3)}, them ${p.them.toFixed(3)}`)
        peakSinceLog.current = { me: 0, them: 0 }
      }
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
  }, [target, useMic, recordPath, store, startedAt, log])

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

  const log = new SessionLog(session.logPath)
  log.append(`session started: ${session.title}`)
  // Which code recorded this session. A data-loss postmortem once had to
  // infer the build from behavioral fingerprints; never make that necessary
  // again. The CLI runs from the repo, so the git rev is the CLI version; the
  // helper is a build artifact that can lag the repo, so its mtime matters.
  log.append(`build: ${repoRevision()}, helper built ${binaryMtime(CAPTURE_BINARY)}`)
  log.append(`target: ${describeSource(target)}; mic: ${useMic ? 'on' : 'off'}`)
  log.append(`recording to: ${session.audioPath}`)

  // `store.session` reflects what the helper actually delivered; fall back to
  // the requested channels if it never got as far as a `ready`.
  const snapshot = () => ({
    turns: store.window(Number.POSITIVE_INFINITY),
    endedAt: new Date(),
    source: describeSource(target),
    channels: (store.session?.channels ?? (useMic ? ['me', 'them'] : ['them'])) as Channel[],
    sampleRate: store.session?.sampleRate ?? null
  })

  // Checkpoint the transcript every 30s so a crash, a kill, or a closed
  // terminal costs at most the last interval. A 50-minute conversation was
  // once lost to an end-only write; never again.
  let checkpointed = 0
  const checkpointer = setInterval(() => {
    if (store.transcriptRevision === checkpointed) return
    checkpointed = store.transcriptRevision
    conversations.checkpoint(session, snapshot()).catch(() => {
      // A failed checkpoint must never take the session down; the next tick
      // retries, and finalize still runs at quit.
      checkpointed = -1
    })
  }, 30_000)

  // A terminal closing (SIGHUP) or a polite kill (SIGTERM) bypasses the TUI's
  // quit path — save what we have before going down.
  const emergencySave = (signal: string) => {
    clearInterval(checkpointer)
    log.append(`received ${signal} — saving and exiting`)
    conversations
      .finalize(session, snapshot())
      .catch(() => {})
      .finally(() => log.flush().finally(() => process.exit(0)))
  }
  process.on('SIGHUP', () => emergencySave('SIGHUP'))
  process.on('SIGTERM', () => emergencySave('SIGTERM'))

  const { waitUntilExit } = render(
    React.createElement(App, {
      target,
      useMic,
      recordPath: session.audioPath,
      store,
      startedAt: session.startedAt.getTime(),
      log
    })
  )
  await waitUntilExit()
  clearInterval(checkpointer)

  const result = snapshot()
  await conversations.finalize(session, result)
  log.append(`session finalized: ${result.turns.length} turn(s) transcribed`)
  await log.flush()

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
        'transcriber — record a conversation and save it as a transcript\n\n' +
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
