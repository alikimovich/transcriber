// Supervisor tests.
//
// These drive a scripted fake helper rather than the real Swift binary, so they
// exercise the restart policy without needing audio hardware. Both bugs these
// cover were found by running the real chain, not by unit tests — a retiring
// helper's late `ready` being taken for the live one, and a replacement being
// started while the outgoing helper still held the audio device.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureSupervisor } from '../src/supervisor.ts'
import type { CaptureEvent } from '../src/types.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'il-supervisor-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Writes a fake helper. `body` is bash run per invocation; a counter file lets
 * it behave differently on each launch, the way a flaky tap does.
 */
function fakeHelper(body: string): string {
  const path = join(dir, 'fake-helper')
  writeFileSync(
    path,
    `#!/bin/bash\nCOUNT_FILE="${join(dir, 'count')}"\n` +
      `n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$COUNT_FILE"\n` +
      body,
    'utf8'
  )
  chmodSync(path, 0o755)
  return path
}

function collect(supervisor: CaptureSupervisor) {
  const events: CaptureEvent[] = []
  const restarts: number[] = []
  supervisor.on('event', (e: CaptureEvent) => events.push(e))
  supervisor.on('restarting', (attempt: number) => restarts.push(attempt))
  return { events, restarts }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll until `path` exists, or throw after `timeoutMs`. Avoids racing a fixed
 * sleep against bash spawn latency, which is unbounded under a loaded runner. */
async function waitForFile(path: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return
    await wait(25)
  }
  throw new Error(`timed out waiting for ${path}`)
}

/** Poll `pred` until it is truthy, or give up after `timeoutMs`. Lets a test
 * wait for the condition it actually cares about instead of guessing how long a
 * multi-step spawn/restart sequence takes — which drifts badly when Bun runs
 * test files concurrently and starves these real-time sleeps. */
async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 8000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return true
    await wait(25)
  }
  return false
}

describe('CaptureSupervisor', () => {
  test('parses JSONL and forwards events', async () => {
    const binaryPath = fakeHelper(
      `echo '{"type":"ready","t":1,"sampleRate":48000,"channels":["them"],"locale":"en-US"}'\n` +
        `echo '{"type":"level","t":2,"channel":"them","rms":0.1,"peak":0.5}'\n` +
        `sleep 5\n`
    )
    const supervisor = new CaptureSupervisor({ binaryPath, target: { kind: 'all' } })
    const { events } = collect(supervisor)
    supervisor.start()
    await waitUntil(() => events.length >= 2)
    supervisor.stop()

    expect(events.map((e) => e.type)).toEqual(['ready', 'level'])
  })

  test('never restarts a helper whose tap has already produced audio', async () => {
    // The silent-tap relaunch exists for a tap that comes up dead. Once system
    // audio has flowed, silence is a lull in the conversation — restarting then
    // truncates the recording, which once destroyed minutes of a real call.
    const binaryPath = fakeHelper(
      `echo '{"type":"level","t":1,"channel":"them","rms":0.2,"peak":0.7}'\n` +
        `echo '{"type":"status","t":2,"code":"system_audio_silent","message":"lull"}'\n` +
        `sleep 5\n`
    )
    const supervisor = new CaptureSupervisor({ binaryPath, target: { kind: 'all' } })
    const { events, restarts } = collect(supervisor)
    supervisor.start()
    await waitUntil(() => events.some((e) => e.type === 'status'))
    await wait(200)
    supervisor.stop()

    expect(restarts).toEqual([])
    // The status still reaches the UI; it just no longer costs a restart.
    expect(events.map((e) => e.type)).toEqual(['level', 'status'])
  })

  test('mic audio does not vouch for the tap', async () => {
    // Only system-audio levels prove the tap works. A helper whose mic is loud
    // but whose tap reports silence is exactly the born-dead case: restart it.
    const binaryPath = fakeHelper(
      `echo '{"type":"level","t":1,"channel":"me","rms":0.2,"peak":0.7}'\n` +
        `echo '{"type":"status","t":2,"code":"system_audio_silent","message":"dead"}'\n` +
        `sleep 5\n`
    )
    const supervisor = new CaptureSupervisor({ binaryPath, target: { kind: 'all' } })
    const { restarts } = collect(supervisor)
    supervisor.start()
    await waitUntil(() => restarts.length > 0)
    supervisor.stop()

    expect(restarts).toEqual([1])
  })

  test('ignores a blank or unparseable line without dropping the stream', async () => {
    const binaryPath = fakeHelper(
      `echo ''\n` +
        `echo 'not json at all'\n` +
        `echo '{"type":"level","t":2,"channel":"them","rms":0,"peak":0.9}'\n` +
        `sleep 5\n`
    )
    const supervisor = new CaptureSupervisor({ binaryPath, target: { kind: 'all' } })
    const { events } = collect(supervisor)
    supervisor.start()
    await wait(1300)
    supervisor.stop()

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('level')
  })

  test('relaunches when the tap comes up silent, and stops once audio flows', async () => {
    // First launch reports silence; the second produces real audio.
    const binaryPath = fakeHelper(
      `if [ "$n" -eq 1 ]; then\n` +
        `  echo '{"type":"status","t":1,"code":"system_audio_silent","message":"silent"}'\n` +
        `  sleep 0.2; exit 0\n` +
        `fi\n` +
        `echo '{"type":"level","t":2,"channel":"them","rms":0.2,"peak":0.7}'\n` +
        `sleep 5\n`
    )
    const supervisor = new CaptureSupervisor({ binaryPath, target: { kind: 'all' } })
    const { events, restarts } = collect(supervisor)
    supervisor.start()
    await wait(1500)
    supervisor.stop()

    expect(restarts).toEqual([1])
    // The replacement's audio came through.
    expect(events.some((e) => e.type === 'level' && e.peak > 0)).toBe(true)
  })

  test('waits for the outgoing helper to exit before starting its replacement', async () => {
    // The first helper lingers after SIGTERM the way the real one does while it
    // tears down its tap. Overlapping the two is what broke capture in practice.
    const binaryPath = fakeHelper(
      `if [ "$n" -eq 1 ]; then\n` +
        `  echo '{"type":"status","t":1,"code":"system_audio_silent","message":"silent"}'\n` +
        `  trap 'sleep 0.6; echo "$(date +%s%N) first-exit" >> "${join(dir, 'order')}"; exit 0' TERM\n` +
        `  sleep 10 & wait\n` +
        `fi\n` +
        `echo "$(date +%s%N) second-start" >> "${join(dir, 'order')}"\n` +
        `echo '{"type":"level","t":2,"channel":"them","rms":0.2,"peak":0.7}'\n` +
        `sleep 5\n`
    )
    const supervisor = new CaptureSupervisor({ binaryPath, target: { kind: 'all' } })
    collect(supervisor)
    supervisor.start()
    // Both lines land only after the outgoing helper exits and the replacement
    // starts — the exact ordering under test. Wait for that, don't guess a delay.
    const settled = await waitUntil(async () => {
      const file = Bun.file(join(dir, 'order'))
      if (!(await file.exists())) return false
      return (await file.text()).trim().split('\n').filter(Boolean).length >= 2
    })
    supervisor.stop()
    expect(settled).toBe(true)

    const order = (await Bun.file(join(dir, 'order')).text()).trim().split('\n')
    expect(order).toHaveLength(2)
    expect(order[0]).toContain('first-exit')
    expect(order[1]).toContain('second-start')
  })

  test('drops late events from a helper that has been retired', async () => {
    // A straggling `ready` from the outgoing helper used to reach the transcript
    // store, which treats a second `ready` as a new session and clears itself.
    const binaryPath = fakeHelper(
      `if [ "$n" -eq 1 ]; then\n` +
        `  echo '{"type":"status","t":1,"code":"system_audio_silent","message":"silent"}'\n` +
        `  trap 'echo "{\\"type\\":\\"ready\\",\\"t\\":9,\\"sampleRate\\":48000,\\"channels\\":[\\"them\\"],\\"locale\\":\\"stale\\"}"; exit 0' TERM\n` +
        `  sleep 10 & wait\n` +
        `fi\n` +
        `echo '{"type":"ready","t":2,"sampleRate":48000,"channels":["them"],"locale":"fresh"}'\n` +
        `sleep 5\n`
    )
    const supervisor = new CaptureSupervisor({ binaryPath, target: { kind: 'all' } })
    const { events } = collect(supervisor)
    supervisor.start()
    // Wait for the replacement's fresh `ready`, then give a leaked stale one a
    // beat to also surface — so "exactly one ready" is a real assertion, not a
    // race that happens to observe the fresh one before the stale one arrives.
    await waitUntil(() => events.some((e) => e.type === 'ready' && e.locale === 'fresh'))
    await wait(300)
    supervisor.stop()

    const readies = events.filter((e) => e.type === 'ready')
    expect(readies).toHaveLength(1)
    expect(readies[0]).toMatchObject({ locale: 'fresh' })
  })

  test('passes --record through to the helper only when a record path is set', async () => {
    // The fake helper records the argv it was launched with, so we can assert
    // the flag reaches the Swift side exactly as the wire contract requires.
    const argsFile = join(dir, 'args')
    const binaryPath = fakeHelper(`printf '%s\\n' "$@" > "${argsFile}"\nsleep 5\n`)

    const withoutRecord = new CaptureSupervisor({ binaryPath, target: { kind: 'all' } })
    withoutRecord.start()
    await waitForFile(argsFile)
    withoutRecord.stop()
    expect(await Bun.file(argsFile).text()).not.toContain('--record')

    rmSync(argsFile, { force: true })
    const recordPath = join(dir, 'audio.m4a')
    const withRecord = new CaptureSupervisor({ binaryPath, target: { kind: 'all' }, recordPath })
    withRecord.start()
    await waitForFile(argsFile)
    withRecord.stop()

    const args = (await Bun.file(argsFile).text()).trim().split('\n')
    const recordIndex = args.indexOf('--record')
    expect(recordIndex).toBeGreaterThanOrEqual(0)
    expect(args[recordIndex + 1]).toBe(recordPath)
  })

  test('gives up after the configured number of silent relaunches', async () => {
    const binaryPath = fakeHelper(
      `echo '{"type":"status","t":1,"code":"system_audio_silent","message":"silent"}'\n` +
        `sleep 0.1; exit 0\n`
    )
    const supervisor = new CaptureSupervisor({
      binaryPath,
      target: { kind: 'all' },
      maxSilentRestarts: 2
    })
    const { restarts } = collect(supervisor)
    let gaveUp = false
    supervisor.on('gaveUp', () => {
      gaveUp = true
    })
    supervisor.start()
    await wait(2500)
    supervisor.stop()

    expect(restarts).toEqual([1, 2])
    expect(gaveUp).toBe(true)
  })
})
