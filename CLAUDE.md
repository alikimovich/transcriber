# Interview Lens — working notes for agents

Read this before touching anything. Most of it is knowledge that cost real
debugging time to acquire and is expensive to rediscover.

## What this is

A macOS tool that **records and transcribes conversations** — your own voice
(microphone) and any meeting/call audio playing on the machine (a Core Audio
process tap) — and saves each session as an organized folder: a compressed
stereo audio file plus a plain-markdown transcript.

It is a logger, not an assistant. It does **not** interpret, summarise, answer,
or call any model over the network. Transcription is fully on-device. If you
find yourself adding an "AI layer" — hints, summaries, a provider call — stop:
that was the previous product and was deliberately removed.

macOS 26+, Apple Silicon, single user, no GUI (a live terminal view while
recording; that's it).

## Layout

```
capture/     Swift CLI helper (`ilcapture`). Core Audio process tap + microphone
             + on-device SpeechAnalyzer, and an optional stereo AAC recorder.
             Emits JSONL on stdout, nothing else.
cli/         bun + TypeScript. Transcript assembly, the Ink live view, the
             session store, and the supervisor that owns the helper's lifecycle.
cli/src/store.ts
             The conversation archive: where a session's audio, transcript and
             metadata are written, plus the generated index.
skill/       The `/interview` Claude Code skill. Symlinked to
             ~/.claude/skills/interview by install.sh, so editing it here takes
             effect immediately.
spike/       The original capture spike. Kept because it is the smallest
             reproduction of the tap setup; useful when Core Audio misbehaves.
SPIKE.md     What the spike proved, plus the silent-tap investigation.
README.md    User-facing: build, permissions, privacy, smoke test.
```

The two halves talk over one pipe. `capture/Sources/Protocol.swift` and
`cli/src/types.ts` define the same wire format — **change them together**.

## The two channels

Speaker identity comes from the audio *source*, not diarization:

- **`me`** — the microphone (you).
- **`them`** — system audio (the meeting, the call, whoever else is talking).

This is far more reliable than asking a model to tell voices apart, but it
assumes **headphones**. Without them, `them`'s voice leaks from the speakers
into the mic and lands on both channels. These two strings are the wire
contract; the recorder also maps **me → left, them → right** in the stereo file.

## Commands

```sh
./install.sh              # full setup; safe to re-run
./capture/build.sh        # just the helper; auto-detects a signing identity

cd cli
bun install
bun test                  # no network, no audio hardware needed
bunx tsc --noEmit
bunx biome check src test
bun run src/cli.tsx doctor
bun run src/cli.tsx record --match zoom --title "weekly sync"
```

`cli/package.json` has a `check` script running typecheck, lint and tests.

## Conventions

- **bun**, not npm or node. Matches every recent repo in `~/dev`.
- **biome** for lint and format. Run `bunx biome check --write src test`.
- Swift is built by `capture/build.sh` with plain `swiftc` — there is no
  SwiftPM manifest and no Xcode project. Adding files means adding them to
  `Sources/`; the build globs. **Command Line Tools are sufficient; full Xcode
  is not required.**
- Comments explain *why*, not *what*. Several comments in this codebase are
  load-bearing warnings; don't delete them as noise.

## Where recordings go

The store is `cli/src/store.ts`. Sessions land in the user's Obsidian vault:

```
~/memory/conversations/            (override with INTERVIEW_LENS_CONVERSATIONS)
  AGENTS.md                        schema, written once; describes the layout
  index.md                        generated catalogue, newest first; rebuilt by
                                   scanning the tree, so it self-heals
  YYYY/MM/YYYY-MM-DD-HHMM[-slug]/
    audio.m4a                      stereo AAC — me on left, them on right
    transcript.md                  header + speaker-labelled, [mm:ss]-stamped turns
    meta.json                      machine-readable session metadata
    log.txt                        capture diagnostics, appended live during the
                                   session — helper stderr (audio formats, tap
                                   timing), status events, restarts, 15s level
                                   peaks. The first place to look when a
                                   recording sounds wrong or a transcript is
                                   empty; it exists because a garbled recording
                                   once shipped with no trace of why.
```

The transcript is a plain file the user can read and edit — that is the point,
not an implementation detail. All writes are temp-file + rename so an
interrupted save can't leave a half-written file — except `log.txt`, which is
append-as-it-happens so a crashed session still leaves its evidence.

`scripts/parakeet-compare.sh <session-dir>` transcribes a saved session with
Parakeet (via `uvx parakeet-mlx`) and writes `transcript-parakeet.md` beside the
on-device transcript for engine comparison. It is deliberately a script, not a
CLI feature: the product stays SpeechAnalyzer-only and dependency-free.

## Invariants — do not break these

**Privacy is now "local, not nowhere".** This is the one invariant that
*changed* with the pivot. Previously audio never touched disk; now recording
audio **is the product**, so a session's audio and transcript are written to
`~/memory/conversations`. What holds firm: transcription is fully on-device and
**there are no network calls at all** — nothing is sent anywhere. If a change
adds a network call, that is a product decision, not an implementation detail —
surface it loudly.

**stdout is a protocol channel.** In `ilcapture`, stdout is JSONL; use `note()`
(stderr) for anything human-facing. A stray `print` breaks the channel silently.

**The capture path never prompts for permission.** A headless helper blocking
on a modal dialog is indistinguishable from a hang — this cost three debugging
rounds. `ilcapture request-mic` is the only place that may prompt.

**Never `SIGKILL` the helper.** It leaks a process tap and a private aggregate
audio device, both invisible, and truncates the audio file before its AAC
trailer is written. `SIGTERM` and wait.

## Things that will bite you

### Core Audio

- **The aggregate device must be anchored to a real output device** as its
  clock source. Without it, `AudioDeviceCreateIOProcIDWithBlock` hangs forever
  with no error, no timeout, and no permission prompt.
- **A silent tap is not an error state.** Callbacks arriving with all-zero
  samples means either a missing system-audio grant *or* a genuinely quiet
  target. They are indistinguishable; report state, don't throw.
- **~1 launch in 3 comes up silent.** Measured: identical callback counts and
  formats in silent and working runs. In-process retry never helps; relaunching
  does. `cli/src/supervisor.ts` owns that mitigation. Root cause unknown — if
  you find it, delete a lot of code.
- **Tap setup costs ~7.5s** (`AudioHardwareCreateAggregateDevice`). Loading
  both speech models costs 0.3s. Don't go optimizing the wrong one.
- A tapped process object goes stale when that process exits; the tap then
  yields silence. Long-lived targets (Zoom) are fine.
- **`kAudioTapPropertyFormat` lies about the delivered stream.** It describes
  the mixdown as the tap defines it; the IOProc's buffers are in the
  *aggregate's input stream* format, which follows the output device. AirPods
  drop to 24 kHz mono in hands-free profile during a call while the tap keeps
  claiming 48 kHz stereo — wrapping buffers with the claim then reads 4× too
  many frames per second: chipmunked audio the transcriber can't read and the
  recorder pads into rhythmic 5–6 Hz chop (diagnosed from a real corrupted
  recording; de-chopping and slowing 4× recovered clean speech). Read
  `kAudioStreamPropertyVirtualFormat` from the aggregate's input streams
  instead, wrap only the tap's buffer (the *last* input stream — a headset mic
  adds device input streams before it), and listen for format changes: the
  profile switch happens mid-session when a call starts. `SystemAudioTap`
  does all three; the recorder also warns once if a channel produces real
  samples at well under its declared rate, which is this failure's signature.

### Swift

- `Int(-Double.infinity)` **traps**. A dB meter hitting silence crashed the
  process before it could report silence. Clamp before converting.
- `finalizeAndFinishThroughEndOfInput()` hangs forever unless the input
  stream's continuation is finished first. Teardown is time-capped for this
  reason.
- `AVAudioConverter` needs `primeMethod = .none`, or it primes with silence and
  shifts every downstream timestamp. Both the transcriber and the recorder
  convert incoming buffers, so both set this.
- `SpeechTranscriber` reporting options are `.volatileResults`,
  `.alternativeTranscriptions`, `.fastResults` — there is no
  `.frequentFinalization` (that belongs to `DictationTranscriber`). WWDC slides
  show preset names that no longer exist.
- **A volatile result is not guaranteed to be reissued as final.** Dropping
  volatiles loses real speech; `TranscriptStore` retires them instead.
- Check assets with `AssetInventory.status(forModules:)`.
  `SpeechTranscriber.installedLocales` is unreliable, and
  `assetInstallationRequest` returns non-nil even when already installed.

### The recorder (`AudioRecorder.swift`)

- The two channels arrive on **independent realtime callbacks** at possibly
  different formats. The recorder resamples each to a common 48kHz mono, then
  paces a stereo write off the wall clock, zero-filling whichever channel is
  momentarily behind — so a muted or absent mic just yields silence on the left
  and the me→L / them→R mapping stays stable regardless of which channels live.
- It writes to `AVAudioFile` configured for AAC; PCM buffers are encoded on
  write. A failed file open reports a `capture_error` status and leaves
  recording off — it must **never** take the capture session down.
- It shares the teardown budget with the transcriber. Anything it does on
  `finish()` (drain + close) has to be quick; a stuck close would wedge exit,
  and a `SIGKILL` fallback would corrupt the file.

### TypeScript

- Use `readline` over child stdout, never `chunk.split('\n')` — the latter
  silently drops events straddling chunk boundaries.
- `parseEvent` is deliberately non-strict: unknown keys are ignored so a newer
  helper that adds a field does not break an older CLI.

### Supervisor

The lifecycle is subtler than it looks, and both bugs here were found by
running the whole chain rather than the parts:

- A retiring helper keeps emitting for seconds after `SIGTERM`. Its late
  `ready` looks like a new session to `TranscriptStore`, which clears itself.
  Events are tagged with a spawn generation, retired the moment we decide to
  replace a helper — not when the replacement spawns.
- A replacement must not start until the outgoing helper has actually exited,
  because it still owns the tap, the aggregate device *and* the audio file.
  Overlapping them produces a newcomer that captures nothing. The record path
  is reused across a restart; the outgoing helper closes its file first, and
  the replacement truncates.

`cli/test/supervisor.test.ts` drives a scripted fake helper, so this is
testable without audio hardware. Extend that rather than testing by hand.

### Anything that probes the tap must tolerate the 1-in-3 silent start

`doctor` originally reported "permission missing" on a single silent probe,
which is a false alarm a third of the time — worse than not checking. It now
retries once before concluding anything. Any new diagnostic has the same
obligation.

## Testing

Unit tests cover the pure logic: transcript windowing and volatile handling,
supervisor lifecycle (including `--record` passthrough), and the store
(session-dir naming and collisions, transcript rendering, `meta.json`, index
rebuild). They need no network and no audio.

What tests can't cover, and must be checked by hand — see the smoke checklist
in README.md: permission prompts, real speaker-channel separation, and that the
saved `audio.m4a` is valid, playable, and has the mic on the left channel.

## Known gaps

- **The microphone channel is lightly exercised** — most runs so far were
  system-audio-only.
- **The live view has had limited real-terminal time.** Ink is verified working
  under this bun; the component is pure.
- **`record` prints the saved path as soon as the live view exits**, which can
  be a moment before the helper finishes flushing the AAC trailer. The
  transcript and metadata are complete at that point; the audio file may need a
  beat longer.
