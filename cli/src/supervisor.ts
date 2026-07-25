// Supervises the Swift capture helper.
//
// The helper brings its system-audio tap up silent on roughly one launch in
// three — callbacks arrive at the right rate with the right format, but every
// sample is zero. Rebuilding the tap inside the process never helps; relaunching
// the process does. See SPIKE.md. So this is where that mitigation lives.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { CaptureEvent } from './types.ts'

export type CaptureTarget =
  | { kind: 'process'; pids: number[] }
  | { kind: 'match'; text: string }
  | { kind: 'all' }

export interface SupervisorOptions {
  binaryPath?: string
  target: CaptureTarget
  useMic?: boolean
  locale?: string
  /** How many times to relaunch after a silent start before giving up. */
  maxSilentRestarts?: number
}

export interface SupervisorEvents {
  event: (e: CaptureEvent) => void
  /** Helper is being relaunched because its tap came up silent. */
  restarting: (attempt: number, max: number) => void
  /** Relaunching did not recover; the tap is silent for a different reason. */
  gaveUp: () => void
  exit: (code: number | null) => void
  stderr: (line: string) => void
}

function targetArgs(target: CaptureTarget): string[] {
  switch (target.kind) {
    case 'process':
      return target.pids.flatMap((pid) => ['--system-pid', String(pid)])
    case 'match':
      return ['--system-match', target.text]
    case 'all':
      return ['--system-all']
  }
}

export class CaptureSupervisor extends EventEmitter {
  private child?: ReturnType<typeof spawn>
  private silentRestarts = 0
  /** Bumped per spawn so late events from a retiring helper can be ignored. */
  private generation = 0
  private stopping = false
  private readonly binaryPath: string
  private readonly maxSilentRestarts: number

  constructor(private readonly options: SupervisorOptions) {
    super()
    this.binaryPath = options.binaryPath ?? resolve(import.meta.dirname, '../../capture/ilcapture')
    this.maxSilentRestarts = options.maxSilentRestarts ?? 3
  }

  start(): void {
    this.stopping = false
    this.spawnHelper()
  }

  stop(): void {
    this.stopping = true
    // SIGTERM lets the helper tear down its tap and aggregate device. SIGKILL
    // would leak both.
    this.child?.kill('SIGTERM')
  }

  private spawnHelper(): void {
    const args = [
      'capture',
      ...targetArgs(this.options.target),
      ...(this.options.useMic === false ? ['--no-mic'] : []),
      ...(this.options.locale ? ['--locale', this.options.locale] : [])
    ]

    const child = spawn(this.binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child

    // A helper that has been told to stop keeps emitting for several seconds
    // while it finalizes transcription and tears down its tap. Those late
    // events must not be mistaken for the replacement's: in particular a
    // straggling `ready` arriving after the new helper's own `ready` looks like
    // a second session to the transcript store, which clears itself.
    this.generation += 1
    const generation = this.generation
    const isCurrent = () => generation === this.generation

    if (!child.stdout || !child.stderr) {
      this.emit('stderr', 'helper started without pipes')
      return
    }

    // readline buffers partial lines across chunk boundaries, which a naive
    // split on '\n' would drop.
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim() || !isCurrent()) return
      let event: CaptureEvent
      try {
        event = JSON.parse(line) as CaptureEvent
      } catch {
        this.emit('stderr', `unparseable line from helper: ${line}`)
        return
      }
      this.handleEvent(event)
    })

    createInterface({ input: child.stderr }).on('line', (line) => {
      // Keep logging a retiring helper's stderr; it explains the handover.
      if (line.trim()) this.emit('stderr', isCurrent() ? line : `(retiring) ${line}`)
    })

    child.on('exit', (code) => {
      if (!this.stopping && isCurrent()) this.emit('exit', code)
    })
  }

  /**
   * Retire the current helper and start a replacement once it has actually
   * exited.
   *
   * Waiting for the exit matters: the outgoing helper still owns a process tap
   * and an aggregate audio device until its teardown completes, which takes a
   * few seconds. Starting the replacement before then leaves two helpers
   * contending for the same device, and the newcomer comes up producing
   * nothing at all — which is exactly the failure the restart was supposed to
   * fix.
   */
  private replaceHelper(): void {
    const outgoing = this.child
    if (!outgoing || outgoing.exitCode !== null) {
      this.spawnHelper()
      return
    }

    let replaced = false
    const spawnOnce = () => {
      if (replaced || this.stopping) return
      replaced = true
      this.spawnHelper()
    }

    outgoing.once('exit', spawnOnce)
    // Don't wait forever on a helper that refuses to die.
    setTimeout(() => {
      if (!replaced) {
        outgoing.kill('SIGKILL')
        spawnOnce()
      }
    }, 6000)

    outgoing.kill('SIGTERM')
  }

  private handleEvent(event: CaptureEvent): void {
    // A silent tap reported at startup is the known intermittency. Relaunch.
    if (event.type === 'status' && event.code === 'system_audio_silent' && !this.stopping) {
      if (this.silentRestarts < this.maxSilentRestarts) {
        this.silentRestarts += 1
        this.emit('restarting', this.silentRestarts, this.maxSilentRestarts)
        this.replaceHelper()
        return
      }
      // Out of retries. Pass it through: at this point the likeliest causes are
      // a missing permission grant or a genuinely quiet target, neither of
      // which another relaunch will fix.
      this.emit('gaveUp')
    }

    // Real audio means the tap is healthy; stop counting past failures against
    // a long-running session.
    if (event.type === 'level' && event.peak > 0) this.silentRestarts = 0

    this.emit('event', event)
  }
}
