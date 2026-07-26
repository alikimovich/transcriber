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

Transcription runs on-device and free. Interpretation goes to **Grok
(xAI)** by default; OpenAI is supported and switchable without a code change.

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

**Lens does not build your context — an agent does.** Your resume, the job
posting and your notes live in a markdown wiki in your Obsidian vault, written
and maintained by Claude Code through the `/interview` skill. Lens reads one
short file out of it. Claude Code already reads PDFs, fetches pages and writes
markdown, and it can ask you questions while it works; a subcommand can't.

## Install

```sh
git clone git@github.com:alikimovich/interview-lens.git
cd interview-lens
./install.sh
```

The installer checks prerequisites, asks for everything it needs in one block,
then builds and configures without further interruption. It's safe to re-run —
anything already in place is detected and skipped.

It will ask for:

- which **provider** interprets questions — Grok (default) or OpenAI
- that provider's **API key** (stored in the login Keychain, not a dotfile) —
  optional; everything except interpretation works without it
- which **signing certificate** to use, if you have more than one
- whether to put the `interview-lens` command on your PATH
- whether to grant **microphone** access now
- whether to fill in your **job description and notes** now

Requirements: Apple Silicon, macOS 26+, and the **Command Line Tools**
(`xcode-select --install`, about 1GB). Full Xcode is *not* needed — the build
calls `swiftc` directly. `bun` is installed automatically if missing.

### Signing

The helper carries an embedded `Info.plist` and is code-signed. That's what
makes permission grants stick: macOS keys them to the code signature and bundle
identifier. With a Developer ID certificate the grants survive rebuilds; with
ad-hoc signing (the automatic fallback) macOS re-asks every time the binary
changes. Both work.

### Manual build

```sh
./capture/build.sh          # → capture/ilcapture, auto-detects a signing identity
cd cli && bun install
```

## Your interview context

```
~/memory/interview-lens/          in your Obsidian vault
  AGENTS.md                       conventions, so any agent knows the layout
  index.md                        generated catalogue
  log.md                          what was ingested, when
  profile.md                      who you are
  experience/<slug>.md            one page per role or project
  target/<slug>.md                one page per interview
  target/<slug>.briefing.md       ← the only file Lens reads
  notes.md                        yours
```

Build it in Claude Code:

```
/interview
```

Give it a resume, a job posting URL, a folder of notes — it reads them, asks
about anything ambiguous, and writes the wiki. Everything is markdown you can
open and edit in Obsidian.

**The briefing is deliberately separate from the wiki.** It goes in front of the
transcript on every keypress, so it has to stay under about 3000 characters
while the wiki behind it can be as long as you like.

```sh
interview-lens target new acme     # start a new interview
interview-lens target list         # * marks the active one
interview-lens context show        # exactly what gets sent
interview-lens context edit        # open the wiki
```

If you never set up a wiki, `interview-lens setup` still works as a manual
fallback.

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
interview-lens doctor                # permissions, audio, credentials
interview-lens setup                 # job description, notes, interviewer role
interview-lens run --match zoom      # live session
interview-lens mcp                   # serve the transcript over MCP on stdio

# raw capture, no UI — useful for debugging
./capture/ilcapture list
./capture/ilcapture capture --system-match zoom | jq -c 'select(.type=="transcript")'
```

In a session: **space** interprets the current question, **c** clears the
transcript, **q** quits.

To switch provider, re-run `./install.sh`, or override a single run:

```sh
INTERVIEW_LENS_PROVIDER=openai interview-lens run --match zoom
```

## Privacy

- Audio is never written to disk, and never leaves the machine — transcription
  is fully on-device via Apple's `SpeechAnalyzer`.
- Transcripts are held in memory only.
- The only thing persisted is the setup context you type in (job description,
  notes, interviewer role), under
  `~/Library/Application Support/interview-lens/context.json`.
- The only network call is the interpretation request, which sends transcript
  text and your setup context to the configured provider. Both providers are
  called on stateless endpoints — nothing is retained server-side.
- API keys live in the login Keychain, not an exported shell variable, so they
  aren't handed to every process you start. `XAI_API_KEY` / `OPENAI_API_KEY`
  still override when set.
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

**Startup takes about nine seconds.** Almost all of it is
`AudioHardwareCreateAggregateDevice` — measured at ~7.5s, against 0.3s to load
both speech models. That's Core Audio's cost, not ours. Start the session
before the call rather than during it.

**The system tap comes up silent on roughly one launch in three.** Callbacks
arrive at the normal rate with the correct format; every sample is just zero.
Rebuilding the tap in-process never helps, so `interview-lens run` supervises
the helper and relaunches it, showing `restarting capture (1/3)`. Because a
retiring helper holds its tap until teardown finishes, the replacement only
starts once the old process has actually exited — starting it sooner leaves two
helpers contending for the device and the newcomer produces nothing. A recovery
therefore costs another startup cycle. Root cause unidentified; see SPIKE.md.

**Without headphones the channels bleed.** The interviewer's voice comes out of
your speakers and back in through the microphone, so the same question lands on
both channels. Wear headphones.
