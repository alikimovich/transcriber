# Interview Lens

Listens to a live interview, keeps the conversation in context, and explains
what the interviewer is probably probing for. It interprets questions; it does
not answer them.

```
Likely testing   Whether you partner with PMs proactively or wait for specs.
Emphasize        How you shaped the problem and influenced the decision.
Clarify          "Would an example from early discovery be most useful?"
```

macOS 26+, Apple Silicon, single user. No GUI — a terminal UI, plus an MCP
server so an agent can query the live transcript.

## How it's put together

Two processes, one pipe:

```
ilcapture (Swift)                          interview-lens (bun/TS)
─────────────────────────                  ────────────────────────────
Core Audio process tap  ─┐                 rolling transcript
AVAudioEngine mic       ─┼── JSONL ──▶     TUI · MCP server · OpenAI
2× SpeechTranscriber    ─┘   stdout        
```

Core Audio taps and on-device speech recognition are Apple-only frameworks, so
that half is Swift. MCP and terminal UI are far better served in TypeScript.

Three decisions worth knowing about:

**Speaker identity comes from the audio source, not diarization.** Whatever
arrives on the system tap is the interviewer; whatever arrives on the mic is
you. This is much more reliable than asking a model to tell voices apart —
but it assumes headphones. Without them the interviewer's voice leaks from
your speakers into the microphone and lands on both channels.

**The tap can be scoped to a single process.** `--system-match zoom` captures
Zoom and nothing else, so Spotify and notification chimes never enter the
transcript. This is the main capability that made a native helper worth it over
an Electron app, which can only capture all system output.

**No heuristic picks "the last question".** The model receives the last few
minutes of channel-labelled transcript and works out what was asked. Removing
the selector removed a whole class of bugs.

## Build

Requires full Xcode (26.5) selected, not just Command Line Tools:

```sh
sudo xcode-select -s /Applications/Xcode-26.5.0.app   # once
./capture/build.sh                                     # → capture/ilcapture
cd cli && bun install
```

The capture helper is signed with a Developer ID and carries an embedded
`Info.plist`. That plist is what makes the permission grants stick: TCC keys
them to the code signature and bundle identifier, so an unsigned or re-branded
build gets re-prompted.

## Permissions to grant

| Permission | When it's asked | Where to fix it |
|---|---|---|
| System audio recording | first capture | Privacy & Security → Screen & System Audio Recording |
| Microphone | `ilcapture request-mic` | Privacy & Security → Microphone |

The capture path deliberately never shows a permission dialog — a headless
helper blocking on a modal prompt is indistinguishable from a hang. Run
`./capture/ilcapture request-mic` once, up front.

A missing microphone degrades the session to interviewer-only rather than
failing it; the interviewer channel is the one carrying the questions.

## Run

```sh
./capture/ilcapture list                        # what's producing audio
./capture/ilcapture request-mic                 # once, ever

# raw capture, no UI — useful for debugging
./capture/ilcapture capture --system-match zoom | jq -c 'select(.type=="transcript")'
```

## Privacy

- Audio is never written to disk, and never leaves the machine — transcription
  is fully on-device via Apple's `SpeechAnalyzer`.
- Transcripts are held in memory only.
- The only thing persisted is the setup context you type in (job description,
  notes, interviewer role), under
  `~/Library/Application Support/interview-lens/context.json`.
- The only network call is the interpretation request to OpenAI, which sends
  transcript text and your setup context. It is sent with `store: false`.
- No telemetry.

## Manual smoke test

1. `./capture/ilcapture list` — the meeting app appears, marked `▶` while it
   plays audio.
2. Play a video in a browser; `ilcapture capture --system-match <browser>`
   shows rising levels and transcript lines on the `interviewer` channel.
3. Scoping: with audio playing, tap a *different* process — levels stay at
   zero. This is what proves per-process isolation.
4. `request-mic`, grant, then capture: speaking produces `candidate` lines.
5. Wearing headphones, confirm your voice appears only on `candidate` and the
   remote voice only on `interviewer`. Without headphones, expect bleed —
   that's the known limitation, not a bug.
6. Stop with Ctrl-C; confirm the process exits and no aggregate audio device is
   left behind (`ilcapture list` still works, system audio still plays).
7. Confirm no audio files were written: `find ~/Library/Application\ Support/interview-lens -type f`
   should show only `context.json`.

## Known issues

- **The system tap intermittently comes up silent** (~1 run in 3 before
  mitigation). The helper now settles the aggregate device before starting IO
  and retries once, reporting `system_audio_silent` if it still fails. See
  SPIKE.md.
- Startup takes a few seconds while the speech models load.
