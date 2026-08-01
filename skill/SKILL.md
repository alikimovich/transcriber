---
name: transcriber
description: Record and browse conversations with Transcriber — start a recording of a live meeting or call (your mic + system audio, transcribed on-device), and search, read, or tidy the saved transcript archive. Use whenever the user wants to record or transcribe a conversation/meeting/call, or asks about something from a past recorded conversation ("start recording this call", "what did I discuss with X", "find the meeting where we talked about Y", "transcribe this"). It records and reads local files; it never sends anything over the network.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# /transcriber — record and browse conversations

Transcriber records a live conversation on-device — your microphone (`me`)
and any meeting/call audio on the machine (`them`) — and saves each session as a
folder with a compressed stereo `audio.m4a`, a markdown `transcript.md`, and
`meta.json`. There is no AI layer: it captures, transcribes, and stores. Your
job is to drive it and to help the user navigate what it saved.

## Where things live

```
~/Documents/Conversations/         (default; the launcher may pin another
                                    root via TRANSCRIBER_CONVERSATIONS)
  AGENTS.md                        the archive schema — read it first
  index.md                        generated catalogue, newest first
  YYYY/MM/YYYY-MM-DD-HHMM[-slug]/
    audio.m4a  transcript.md  meta.json
```

Confirm the root and that things are healthy with:

```sh
transcriber doctor
```

If the command is missing, Transcriber is not installed — point the user at
`install.sh` in the repo (https://github.com/alikimovich/transcriber) and stop.

## Start a recording

Ask what to capture if it isn't obvious, then run it. Headphones give the
cleanest channel separation; on the built-in speakers, echo cancellation kicks
in automatically to keep the other side's voice off the mic channel (the
session's `log.txt` says `echo cancellation: on`).

```sh
transcriber record --match zoom --title "weekly sync"   # just one app
transcriber record --all                                # all system audio
transcriber record --match zoom --no-mic                # them only
```

It shows a live view; the user presses **q** to stop, and the session folder is
written and its path printed. Startup takes ~9s (Core Audio) and the tap comes
up silent about one launch in three — the CLI auto-restarts and shows
`restarting capture (1/3)`; that's expected, not a failure.

## Browse and search the archive

Everything is plain local files — read them directly.

- **Recent sessions:** `Read` the generated `index.md`, or
  `Glob` `<root>/**/meta.json` and read the newest.
- **Find a conversation by content:** `Grep` across
  `<root>/**/transcript.md` for a name, topic or phrase, then
  read the matching transcript.
- **Summarise or extract for the user** from a transcript they point you at —
  that's your job as the agent reading the file, not something Transcriber does.

## Tidy up

When asked, help keep the archive clean: rename a mistitled session folder,
delete an accidental or empty recording (confirm first — deleting the folder
deletes the only copy of that audio), or regenerate `index.md` by re-scanning if
it drifts (`transcriber doctor` reports the store; a future `record` run
rebuilds the index).

## Things to get right

- **Never send a transcript or audio anywhere.** The whole point is that it
  stays on the machine. No web fetches, no uploads.
- **Don't hand-edit `index.md`** — it's generated and will be overwritten.
- If the archive lives inside a synced or indexed folder (an Obsidian vault,
  iCloud, Dropbox), transcripts are searchable there too — but audio syncs as
  well and gets heavy over time. Mention moving the archive with
  `TRANSCRIBER_CONVERSATIONS` if it grows.
- **Confirm before deleting** any session — there is no second copy.
