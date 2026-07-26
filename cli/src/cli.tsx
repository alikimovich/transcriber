#!/usr/bin/env bun
// interview-lens — entry point.
//
//   setup    edit the saved job description / notes / interviewer role
//   run      live session with the terminal UI
//   doctor   check permissions, audio levels, models and credentials
//   mcp      expose the transcript over MCP on stdio
//   clear    forget the saved setup context

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { render } from 'ink'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { clearContext, contextPath, loadContext, saveContext } from './config.ts'
import { apiKeySource } from './credentials.ts'
import { interpret } from './interpret.ts'
import { serveStdio } from './mcp.ts'
import { resolveProvider } from './providers/index.ts'
import { loadSettings, type Settings } from './settings.ts'
import { CaptureSupervisor, type CaptureTarget } from './supervisor.ts'
import { TranscriptStore } from './transcript.ts'
import { Tui, type ViewState } from './tui.tsx'

const CAPTURE_BINARY = resolve(import.meta.dirname, '../../capture/ilcapture')

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function parseTarget(argv: string[]): CaptureTarget {
  const matchIndex = argv.indexOf('--match')
  if (matchIndex !== -1 && argv[matchIndex + 1]) {
    return { kind: 'match', text: argv[matchIndex + 1] as string }
  }
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

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function App({
  target,
  useMic,
  settings
}: {
  target: CaptureTarget
  useMic: boolean
  settings: Settings
}) {
  const storeRef = useRef(new TranscriptStore())
  const supervisorRef = useRef<CaptureSupervisor | null>(null)
  const startedAt = useRef(Date.now())
  const inFlight = useRef<AbortController | null>(null)

  const [, forceRender] = useState(0)
  const [state, setState] = useState<ViewState>({
    target: describeTarget(target),
    ready: false,
    channels: ['interviewer'],
    levels: {
      interviewer: { rms: 0, peak: 0 },
      candidate: { rms: 0, peak: 0 }
    },
    turns: [],
    hintPending: false,
    elapsedSeconds: 0
  })

  useEffect(() => {
    const store = storeRef.current
    const supervisor = new CaptureSupervisor({
      binaryPath: CAPTURE_BINARY,
      target,
      useMic
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
        elapsedSeconds: (Date.now() - startedAt.current) / 1000
      }))
      forceRender((n) => n + 1)
    }, 1000)

    return () => {
      clearInterval(ticker)
      supervisor.stop()
    }
  }, [target, useMic])

  const onInterpret = useCallback(async () => {
    // A newer question supersedes an older one still in flight.
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller

    setState((prev) => ({
      ...prev,
      hintPending: true,
      hintError: undefined
    }))

    const turns = storeRef.current.window(300)
    if (turns.length === 0) {
      setState((prev) => ({
        ...prev,
        hintPending: false,
        hintError: 'nothing transcribed yet'
      }))
      return
    }

    const result = await interpret(
      { turns, context: await loadContext() },
      {
        signal: controller.signal,
        savedProvider: settings.provider,
        model: settings.model ?? undefined
      }
    )
    if (controller.signal.aborted) return

    setState((prev) => {
      if (result.kind === 'ok') {
        return {
          ...prev,
          hintPending: false,
          hint: result.interpretation,
          hintError: undefined
        }
      }
      const message =
        result.kind === 'refusal'
          ? 'the model declined to interpret that'
          : result.kind === 'incomplete'
            ? `response cut off (${result.reason})`
            : result.kind === 'malformed'
              ? 'the model returned something unusable'
              : result.message
      return { ...prev, hintPending: false, hintError: message }
    })
  }, [])

  const onClear = useCallback(() => {
    storeRef.current.clear()
    setState((prev) => ({
      ...prev,
      turns: [],
      hint: undefined,
      hintError: undefined,
      notice: { text: 'transcript cleared', severity: 'info' }
    }))
  }, [])

  const onQuit = useCallback(() => {
    supervisorRef.current?.stop()
  }, [])

  return React.createElement(Tui, {
    state,
    onInterpret,
    onClear,
    onQuit
  })
}

async function runSession(argv: string[]): Promise<void> {
  const target = parseTarget(argv)
  const useMic = !argv.includes('--no-mic')
  const settings = await loadSettings()
  const provider = resolveProvider(null, settings.provider)
  if (apiKeySource(provider) === 'none') {
    process.stderr.write(
      `warning: no ${provider.label} API key — transcription will work, interpretation will not.\n`
    )
  }
  const { waitUntilExit } = render(React.createElement(App, { target, useMic, settings }))
  await waitUntilExit()
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

const SETUP_TEMPLATE = `# Lines starting with # are ignored.
# Everything under each heading is used as-is.

## Job description

{{JOB}}

## Notes

{{NOTES}}

## Interviewer role

{{ROLE}}
`

function parseSetupFile(text: string): {
  jobDescription: string
  notes: string
  interviewerRole?: string
} {
  const sections: Record<string, string[]> = {}
  let current = ''
  for (const line of text.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      current = (heading[1] as string).toLowerCase()
      sections[current] = []
      continue
    }
    if (line.startsWith('#')) continue
    if (current) sections[current]?.push(line)
  }
  const get = (key: string) => (sections[key] ?? []).join('\n').trim()
  const role = get('interviewer role')
  return {
    jobDescription: get('job description'),
    notes: get('notes'),
    ...(role ? { interviewerRole: role } : {})
  }
}

async function runSetup(): Promise<void> {
  const existing = await loadContext()
  const body = SETUP_TEMPLATE.replace('{{JOB}}', existing.jobDescription)
    .replace('{{NOTES}}', existing.notes)
    .replace('{{ROLE}}', existing.interviewerRole ?? '')

  const dir = mkdtempSync(join(tmpdir(), 'interview-lens-'))
  const file = join(dir, 'context.md')
  writeFileSync(file, body, 'utf8')

  const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
  const result = spawnSync(editor, [file], { stdio: 'inherit' })
  if (result.status !== 0) fail('editor exited without saving; nothing changed')

  const context = parseSetupFile(readFileSync(file, 'utf8'))
  if (!context.jobDescription && !context.notes) {
    fail('both the job description and notes were empty; nothing saved')
  }
  await saveContext(context)
  process.stdout.write(`saved to ${contextPath()}\n`)
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
  out('credentials')
  const settings = await loadSettings()
  const provider = resolveProvider(null, settings.provider)
  out(`  using ${provider.label} · ${settings.model ?? provider.defaultModel}`)
  const source = apiKeySource(provider)
  if (source === 'env') good(`API key from ${provider.envVar}`)
  else if (source === 'keychain') good('API key from the login Keychain')
  else bad(`no ${provider.label} API key — run ./install.sh, or set ${provider.envVar}`)

  out('')
  out('setup context')
  const context = await loadContext()
  if (context.jobDescription || context.notes) {
    good(
      `${context.jobDescription.length} chars of job description, ` +
        `${context.notes.length} chars of notes`
    )
  } else {
    bad('no job description or notes saved — run `interview-lens setup`')
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
    case 'run':
      return runSession(argv)
    case 'setup':
      return runSetup()
    case 'doctor':
      return runDoctor()
    case 'mcp':
      // stdout is the JSON-RPC channel from here on.
      return serveStdio({ transcript: new TranscriptStore() })
    case 'clear':
      await clearContext()
      process.stdout.write('setup context cleared\n')
      return
    default:
      process.stdout.write(
        'interview-lens — interprets interview questions in real time\n\n' +
          '  setup     edit the job description, notes and interviewer role\n' +
          '  run       start a live session (--match zoom | --pid N | --all)\n' +
          '  doctor    check permissions, audio, models and credentials\n' +
          '  mcp       serve the transcript over MCP on stdio\n' +
          '  clear     forget the saved setup context\n'
      )
      process.exit(command ? 64 : 0)
  }
}

await main()
