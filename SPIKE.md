# Capture spike — findings

Run `spike/build.sh` then `./spike/ilprobe tap` to reproduce.

## What is proven

| Question | Answer |
|---|---|
| Can a **signed CLI binary** (no `.app` bundle) capture system audio? | **Yes.** Embedded `Info.plist` via `-sectcreate __TEXT __info_plist`, signed with Developer ID. Peak 0.76 / RMS 0.10 on live audio. |
| Can we enumerate audio-producing processes? | **Yes.** `kAudioHardwarePropertyProcessObjectList` → `kAudioProcessPropertyPID` / `…BundleID` / `…IsRunningOutput`. |
| Can a tap be scoped to **one process**? | **Yes, and it isolates cleanly.** Tapping the playing process → peak 0.757. Tapping any other process while the same audio plays → 0.000. |
| Tap audio format | 48000 Hz, 2 ch, 32-bit float. |

Per-process scoping is the reason this is native rather than Electron: the
interviewer channel can be scoped to the meeting app alone, so music and
notification sounds never enter the transcript.

## Two traps, both found the hard way

**1. The aggregate device needs a clock anchor.** A tap-only aggregate with an
empty `kAudioAggregateDeviceSubDeviceListKey` hangs forever inside
`AudioDeviceCreateIOProcIDWithBlock` — no error, no timeout, no TCC prompt. Fix
is to include the default output device as both `MainSubDevice` and
`ClockDevice` and list it in the sub-device list.

**2. `Int(-Double.infinity)` traps in Swift.** The level meter computed
`20*log10(rms)` and converted to `Int` for the bar width. Before any audio
arrives `rms == 0`, so `db == -inf`, and the conversion faults *before* the
surrounding `min`/`max` clamp can run. The silent-stream path — the exact state
we most need to report — crashed instead of reporting. Clamp to a floor in dB
before converting.

## Distinguishable failure states

The probe separates three outcomes, and the real capture layer must too:

- **dead stream** — IOProc never fires. Expected when the tapped process is
  producing no audio at all; also what a broken aggregate looks like. Not by
  itself an error.
- **silent stream** — callbacks fire, every sample is zero. This is the
  signature of a missing system-audio grant.
- **ok** — non-zero peak.

## Open

- **TCC attribution.** No permission prompt appeared during the spike, and the
  TCC database is not readable to confirm why. The probe's parent was the agent
  process, not an interactive terminal. For CLI binaries macOS generally
  attributes the grant to the *responsible* process (the terminal), not the
  binary — meaning the grant may read as "Ghostty can record system audio"
  rather than "Interview Lens can", and may differ per terminal. If that proves
  annoying, wrap the sidecar in a minimal headless `.app` bundle so it gets its
  own TCC identity; the binary itself does not change.
- Two concurrent `SpeechTranscriber` instances (one per channel) — untested.
- Microphone capture and its alignment with the tap clock — untested.
