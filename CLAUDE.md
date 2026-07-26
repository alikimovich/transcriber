# Interview Lens — working notes for agents

Read this before touching anything. Most of it is knowledge that cost real
debugging time to acquire and is expensive to rediscover.

## What this is

A macOS tool that listens to a live job interview and explains what the
interviewer is probing for. It **interprets questions; it never answers them**.
That boundary is a product requirement, not a style preference — if you find
yourself making the output more answer-like, stop.

macOS 26+, Apple Silicon, single user, no GUI.

## Layout

```
capture/     Swift CLI helper. Core Audio process tap + microphone +
             on-device SpeechAnalyzer. Emits JSONL on stdout, nothing else.
cli/         bun + TypeScript. Transcript assembly, Ink TUI, MCP server, and
             the supervisor that owns the helper's lifecycle.
skill/       The `/interview` Claude Code skill. Symlinked to
             ~/.claude/skills/interview by install.sh, so editing it here takes
             effect immediately.
cli/src/context/
             Reading the wiki. Lens only ever reads — the skill does all the
             writing.
cli/src/providers/
             One file per vendor. The prompt, the JSON Schema and the result
             type are ours; a provider supplies only the endpoint, envelope,
             auth header and response walk.
spike/       The original capture spike. Kept because it is the smallest
             reproduction of the tap setup; useful when Core Audio misbehaves.
SPIKE.md     What the spike proved, plus the silent-tap investigation.
README.md    User-facing: build, permissions, privacy, smoke test.
```

The two halves talk over one pipe. `capture/Sources/Protocol.swift` and
`cli/src/types.ts` define the same wire format — **change them together**.

## Commands

```sh
./install.sh              # full setup; safe to re-run
./capture/build.sh        # just the helper; auto-detects a signing identity

cd cli
bun install
bun test                 # 118 tests, no network, no audio hardware needed
bunx tsc --noEmit
bunx biome check src test
bun run src/cli.tsx doctor
```

`cli/package.json` has a `check` script running all three.

## Conventions

- **bun**, not npm or node. Matches every recent repo in `~/dev`.
- **biome** for lint and format. Run `bunx biome check --write src test`.
- Swift is built by `capture/build.sh` with plain `swiftc` — there is no
  SwiftPM manifest and no Xcode project. Adding files means adding them to
  `Sources/`; the build globs. **Command Line Tools are sufficient; full Xcode
  is not required.**
- The API key comes from `loadApiKey(provider)` in `cli/src/credentials.ts`:
  the provider's env var first, then the login Keychain. Don't reintroduce a
  direct `process.env` read.
- **Default provider is xAI (Grok 4.3).** `cli/src/interpret.ts` is the
  transport and must stay vendor-agnostic — if it grows a
  `provider.id === 'xai'` branch, that logic belongs in the provider. Adding a
  vendor means one file in `providers/` plus a registry entry, nothing else.
- Comments explain *why*, not *what*. Several comments in this codebase are
  load-bearing warnings; don't delete them as noise.

## Context is an agent's job, not the CLI's

Lens reads exactly one file at runtime: `target/<slug>.briefing.md` in the
user's wiki. It does not extract PDFs, fetch URLs, walk folders, summarise, or
call a model to build context. All of that is the `/interview` skill, run by
Claude Code or Codex.

This was not the first design. An earlier cut had an in-app ingest pipeline —
PDF extraction, HTML-to-text, an LLM pass with its own schema, a compiled-context
cache with staleness checks. It was ~25KB of code reimplementing, worse, what
the agent driving it already does. It got deleted. If you find yourself adding
source extraction or a summarisation prompt to this repo, that is the signal you
are rebuilding it.

The briefing being a plain file the user can edit is the point, not an
implementation detail: it is the one place they can correct a wrong emphasis
before it shapes every hint of an interview.

## Invariants — do not break these

**Privacy.** Audio never touches disk and never leaves the machine;
transcription is fully on-device. The only network call is the interpretation
request, sent with `store: false`. The only thing persisted is the setup
context the user typed. If a change adds a file write or a network call,
that's a product decision, not an implementation detail — surface it.

**stdout is a protocol channel.** In `ilcapture`, stdout is JSONL; use
`note()` for anything human-facing. In `interview-lens mcp`, stdout is
JSON-RPC; use `console.error`. A stray `print`/`console.log` in either breaks
the channel silently.

**The capture path never prompts for permission.** A headless helper blocking
on a modal dialog is indistinguishable from a hang — this cost three debugging
rounds. `ilcapture request-mic` is the only place that may prompt.

**Never `SIGKILL` the helper.** It leaks a process tap and a private aggregate
audio device, both invisible. `SIGTERM` and wait.

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

### Swift

- `Int(-Double.infinity)` **traps**. A dB meter hitting silence crashed the
  process before it could report silence. Clamp before converting.
- `finalizeAndFinishThroughEndOfInput()` hangs forever unless the input
  stream's continuation is finished first. Teardown is time-capped for this
  reason.
- `AVAudioConverter` needs `primeMethod = .none`, or it primes with silence and
  shifts every downstream timestamp.
- `SpeechTranscriber` reporting options are `.volatileResults`,
  `.alternativeTranscriptions`, `.fastResults` — there is no
  `.frequentFinalization` (that belongs to `DictationTranscriber`). WWDC slides
  show preset names that no longer exist.
- **A volatile result is not guaranteed to be reissued as final.** Dropping
  volatiles loses real speech; `TranscriptStore` retires them instead.
- Check assets with `AssetInventory.status(forModules:)`.
  `SpeechTranscriber.installedLocales` is unreliable, and
  `assetInstallationRequest` returns non-nil even when already installed.

### Providers

- **Grok 4.3, not 4.5, and deliberately.** 4.5 cannot disable reasoning — its
  floor is `low`, its default is `high` — so every call burns reasoning tokens
  before emitting any JSON. For a latency-critical extraction that is exactly
  backwards. 4.3 is the only current model accepting `reasoning_effort: "none"`,
  and it is cheaper.
- **`grok-4`, `grok-4-fast`, `grok-4.1-*`, `grok-3` and `grok-code-fast-1` no
  longer exist** (retired 15 May 2026). The slugs still resolve — they silently
  redirect to `grok-4.3` — so a stale model ID gives you no error, just
  different behaviour and different billing.
- **The two vendors nest the schema differently.** OpenAI Responses flattens it
  (`text.format` with `name` a sibling of `schema`); xAI Chat Completions nests
  it (`response_format.json_schema.{name,schema,strict}`). Copying one shape to
  the other endpoint fails. Both are covered by tests.
- **xAI `finish_reason` can be `end_turn`** — a success terminal with no OpenAI
  equivalent. A switch handling only `stop`/`length` falls through.
- **xAI refusals are a sibling field** (`message.refusal`) with `content: null`,
  not a content part. Check it before parsing.
- **xAI reasoning lands in `message.reasoning_content`**, so it never
  contaminates the JSON — but `max_completion_tokens` defaults to **128,000**,
  not the model max. Always cap it.
- **`presence_penalty`, `frequency_penalty` and `stop` hard-error on xAI
  reasoning models** rather than being ignored.
- **xAI documents no rate-limit headers.** `suggestedDelayMs` returns null there
  and the transport falls back to blind exponential backoff, which is what
  xAI's own docs recommend.
- Both providers' prompt caches match a prefix from the start of the message
  list, so the stable setup context is sent as its own message ahead of the
  volatile transcript. Don't merge them back into one blob.

### TypeScript

- **The MCP TypeScript SDK's GitHub README is for v2, which is not on npm.**
  Pinned here is `@modelcontextprotocol/sdk@1.29.0`, where `inputSchema` takes
  a **raw Zod shape** (`{ q: z.string() }`), not `z.object({...})`, and
  `registerTool`/`registerResource` replace the deprecated `tool()`/`resource()`.
- OpenAI reads results by walking `output[]` for `type === "message"`, then
  `content[]` for `output_text`. **Do not** use `output_text` (SDK-only) or
  index `output[0]` (that's a `reasoning` item when reasoning is on).
- `interpret()` never throws — it returns a union discriminated on `kind`.
  Handle `refusal`, `incomplete`, `malformed`, and `error`.
- Use `readline` over child stdout, never `chunk.split('\n')` — the latter
  silently drops events straddling chunk boundaries.
- Rate-limit reset headers are Go duration strings (`"6m0s"`). `parseInt` gives
  you `6`.

### Supervisor

The lifecycle is subtler than it looks, and both bugs here were found by
running the whole chain rather than the parts:

- A retiring helper keeps emitting for seconds after `SIGTERM`. Its late
  `ready` looks like a new session to `TranscriptStore`, which clears itself.
  Events are tagged with a spawn generation, retired the moment we decide to
  replace a helper — not when the replacement spawns.
- A replacement must not start until the outgoing helper has actually exited,
  because it still owns the tap and aggregate device. Overlapping them produces
  a newcomer that captures nothing — the exact failure the restart was meant to
  fix.

`cli/test/supervisor.test.ts` drives a scripted fake helper, so this is
testable without audio hardware. Extend that rather than testing by hand.

### Anything that probes the tap must tolerate the 1-in-3 silent start

`doctor` originally reported "permission missing" on a single silent probe,
which is a false alarm a third of the time — worse than not checking. It now
retries once before concluding anything. Any new diagnostic has the same
obligation.

## Testing

Unit tests cover the pure logic: transcript windowing and volatile handling,
prompt construction, schema validation, response parsing, supervisor lifecycle.
They need no network and no audio.

What tests can't cover, and must be checked by hand — see the smoke checklist
in README.md: permission prompts, real speaker-channel separation, whether the
hint is genuinely scannable in about two seconds.

To exercise capture without a meeting, generate speech and tap it:

```sh
say -o /tmp/q.aiff "Tell me about a time you disagreed with a product manager."
afplay /tmp/q.aiff & sleep 1
./capture/ilcapture capture --system-all --no-mic --seconds 8 | jq -c 'select(.type=="transcript" and .isFinal)'
```

## Known gaps

- **The OpenAI call has never run against the live API.** Shape follows current
  docs and is unit-tested against mocks, but unconfirmed end to end.
- **The microphone channel has never been exercised** — every run so far was
  interviewer-only.
- **The TUI has never rendered in a real terminal.** Ink is verified working
  under this bun; the component is pure and unrendered.
- No rolling summary yet; the window is a flat last-N-minutes slice.
