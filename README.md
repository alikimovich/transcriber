# Transcriber

Records and transcribes your conversations — your own voice and any meeting or
call playing on your Mac — and saves each one as a folder you own: a compressed
stereo audio file and a plain-markdown transcript. Fully on-device. Nothing is
sent anywhere.

```
~/Documents/Conversations/2026/07/2026-07-28-1432-weekly-sync/
  audio.m4a          stereo AAC — you on the left, everyone else on the right
  transcript.md      speaker-labelled, timestamped
  meta.json          date, duration, source
  log.txt            capture diagnostics — read this if a recording sounds wrong
```

macOS 26+, Apple Silicon, single user. A live terminal view while it records;
no other GUI.

## How it's put together

Two processes, one pipe:

```
tcapture (Swift)                          transcriber (bun/TS)
─────────────────────────                  ────────────────────────────
Core Audio process tap  ─┐                 rolling transcript
AVAudioEngine mic       ─┼── JSONL ──▶     live view · session store
2× SpeechTranscriber    ─┘   stdout        stereo AAC written by the helper
```

Core Audio taps and on-device speech recognition are Apple-only frameworks, so
that half is Swift. The lifecycle, assembly and file writing are TypeScript.

Two decisions worth knowing about:

**Speaker identity comes from the audio source, not diarization.** Whatever
arrives on the system tap is *them*; whatever arrives on the mic is *you*. This
is much more reliable than asking a model to tell voices apart. Headphones give
the cleanest separation; when sound plays through the built-in speakers instead,
the helper enables macOS echo cancellation on the microphone, which subtracts
the speaker output from the mic signal.

**The tap can be scoped to a single process.** `--match zoom` captures Zoom and
nothing else, so Spotify and notification chimes never enter the recording. This
is the main capability that made a native helper worth it over an Electron app,
which can only capture all system output.

## Install

Requirements either way: **Apple Silicon and macOS 26+** (on-device
transcription uses SpeechAnalyzer).

### Homebrew

```sh
brew install alikimovich/tap/transcriber
```

Updates arrive with `brew upgrade` like everything else.

### From a release

Grab the latest zip from
[Releases](https://github.com/alikimovich/transcriber/releases), then:

```sh
unzip transcriber-v*-macos-arm64.zip
mv transcriber-v*-macos-arm64/{transcriber,tcapture} ~/.local/bin/
tcapture request-mic        # grant microphone access once, up front
transcriber doctor
```

The two binaries must stay side by side — `transcriber` looks for its capture
helper next to its own executable. Both are signed and notarized; no build
tools, bun, or Xcode needed. Recordings default to `~/Documents/Conversations`
(set `TRANSCRIBER_CONVERSATIONS` to change that). Later, `transcriber update`
fetches and installs the newest release in place.

### From source

```sh
git clone git@github.com:alikimovich/transcriber.git
cd transcriber
./install.sh
```

The installer checks prerequisites, asks for everything it needs in one block
(including where to store recordings), then builds and configures without
further interruption. It's safe to re-run — anything already in place is
detected and skipped.

Building needs the **Command Line Tools** (`xcode-select --install`, about
1GB). Full Xcode is *not* needed — the build calls `swiftc` directly. `bun` is
installed automatically if missing.

### Signing

The helper carries an embedded `Info.plist` and is code-signed. That's what
makes permission grants stick: macOS keys them to the code signature and bundle
identifier. With a Developer ID certificate the grants survive rebuilds; with
ad-hoc signing (the automatic fallback) macOS re-asks every time the binary
changes. Both work.

### Manual build

```sh
./capture/build.sh          # → capture/tcapture, auto-detects a signing identity
cd cli && bun install
```

## Permissions to grant

| Permission | When it's asked | Where to fix it |
|---|---|---|
| System audio recording | first capture | Privacy & Security → Screen & System Audio Recording |
| Microphone | `tcapture request-mic` | Privacy & Security → Microphone |

The capture path deliberately never shows a permission dialog — a headless
helper blocking on a modal prompt is indistinguishable from a hang. Run
`./capture/tcapture request-mic` once, up front.

A missing microphone degrades the session to *them*-only rather than failing
it, so a call still gets recorded even if you never granted the mic.

## Record

```sh
transcriber doctor                    # permissions, audio, store
transcriber record --match zoom       # record just Zoom
transcriber record --all              # record all system audio
transcriber record --match zoom --title "weekly sync"
transcriber record --all --no-mic     # them only

# raw capture, no session, useful for debugging
./capture/tcapture list
./capture/tcapture capture --system-match zoom | jq -c 'select(.type=="transcript")'
```

While recording you see per-channel level meters, elapsed time, and the live
transcript scrolling by. Press **q** to stop; the session folder — audio,
transcript and metadata — is written and its path printed.

Point the archive somewhere else with `TRANSCRIBER_CONVERSATIONS` (the
installer also asks and bakes the answer into the launcher).

## Privacy

- **Nothing leaves the machine.** Transcription is fully on-device via Apple's
  `SpeechAnalyzer`. The single exception to "no network calls" is the explicit
  `transcriber update` command, which contacts GitHub Releases only when you
  run it; recording, transcription, and every other command never touch the
  network.
- Audio and transcripts are written locally, to `~/Documents/Conversations` (or
  wherever `TRANSCRIBER_CONVERSATIONS` points). Deleting a session folder
  deletes the recording — there is no copy anywhere else.
- Audio is compressed AAC, not lossless — small enough to keep, good enough to
  re-transcribe or feed to other tools later.
- No telemetry.

## Manual smoke test

1. `./capture/tcapture list` — the meeting app appears, marked `▶` while it
   plays audio.
2. Play a video in a browser; `tcapture capture --system-match <browser>`
   shows rising levels and transcript lines on the `them` channel.
3. Scoping: with audio playing, tap a *different* process — levels stay at
   zero. This is what proves per-process isolation.
4. `request-mic`, grant, then capture: speaking produces `me` lines.
5. Wearing headphones, confirm your voice appears only on `me` and the remote
   voice only on `them`. On the built-in speakers, check the session's
   `log.txt` for `echo cancellation: on` and confirm the remote voice stays
   off the `me` channel.
6. `transcriber record --match <browser>`, let it run a bit, stop with **q**;
   confirm a session folder was written and `transcript.md` reads correctly.
7. Play the saved `audio.m4a` (`afplay …/audio.m4a`) — it should be a valid
   stereo file with you on the left, them on the right.
8. Stop and confirm no aggregate audio device is left behind (`tcapture list`
   still works, system audio still plays).

## Known issues

**Startup takes about nine seconds.** Almost all of it is
`AudioHardwareCreateAggregateDevice` — measured at ~7.5s, against 0.3s to load
both speech models. That's Core Audio's cost, not ours. Start recording before
the call rather than during it.

**The system tap comes up silent on roughly one launch in three.** Callbacks
arrive at the normal rate with the correct format; every sample is just zero.
Rebuilding the tap in-process never helps, so `transcriber record` supervises
the helper and relaunches it, showing `restarting capture (1/3)`. Because a
retiring helper holds its tap until teardown finishes, the replacement only
starts once the old process has actually exited. A recovery therefore costs
another startup cycle. Root cause unidentified; see SPIKE.md.

**Speaker playback relies on echo cancellation.** With the built-in speakers as
output, the helper turns on macOS voice processing so the other side's voice is
subtracted from the microphone — at the cost of some noise suppression and
auto-gain coloring the `me` channel. Headphones avoid all of that and remain
the cleanest setup. Switching outputs mid-session doesn't re-evaluate the
choice; it's decided when the recording starts.
