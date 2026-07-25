// ilcapture — the capture helper for Interview Lens.
//
// Taps system audio (the interviewer) and the microphone (the candidate),
// transcribes both on-device, and writes one JSON object per line to stdout.
// It has no UI and no network access; the CLI drives it.

import AVFoundation
import Foundation

let writer = EventWriter()

// MARK: - Argument parsing

struct Options {
    var systemPIDs: [pid_t] = []
    var systemMatch: String?
    var systemAll = false
    var useMic = true
    var seconds: Double?
    var locale = "en-US"
}

func parseOptions(_ args: [String]) -> Options {
    var o = Options()
    var i = 0
    while i < args.count {
        switch args[i] {
        case "--system-pid":
            i += 1
            if i < args.count, let p = pid_t(args[i]) { o.systemPIDs.append(p) }
        case "--system-match":
            i += 1
            if i < args.count { o.systemMatch = args[i] }
        case "--system-all":
            o.systemAll = true
        case "--no-mic":
            o.useMic = false
        case "--seconds":
            i += 1
            if i < args.count { o.seconds = Double(args[i]) }
        case "--locale":
            i += 1
            if i < args.count { o.locale = args[i] }
        default:
            note("unknown option: \(args[i])")
        }
        i += 1
    }
    return o
}

func usage() -> Never {
    note(
        """
        ilcapture — Interview Lens capture helper

          ilcapture list
              List processes currently producing audio.

          ilcapture request-mic
              Ask for microphone access once, interactively.

          ilcapture capture [options]
              Capture and transcribe. Emits JSONL on stdout.

              --system-pid <pid>     tap only this process (repeatable)
              --system-match <text>  tap processes whose name matches
              --system-all           tap all system output
              --no-mic               skip the microphone channel
              --seconds <n>          stop after n seconds
              --locale <id>          transcription locale (default en-US)

        Exactly one of --system-pid / --system-match / --system-all is required.
        """)
    exit(64)
}

// MARK: - Commands

func runList() -> Never {
    let processes = AudioProcesses.all().sorted {
        ($0.isRunningOutput ? 0 : 1, $0.name.lowercased())
            < ($1.isRunningOutput ? 0 : 1, $1.name.lowercased())
    }
    guard !processes.isEmpty else {
        note("No audio processes reported.")
        exit(1)
    }
    note(String(format: "%-8@ %-4@ %@", "PID" as NSString, "OUT" as NSString, "NAME"))
    for p in processes {
        note(String(format: "%-8d %-4@ %@", p.pid, (p.isRunningOutput ? "▶" : "") as NSString, p.name))
    }
    exit(0)
}

/// Resolves which process object IDs to tap, or exits with a useful message.
func resolveTapTargets(_ o: Options) -> [AudioObjectID] {
    if o.systemAll { return [] }

    if let match = o.systemMatch {
        let found = AudioProcesses.search(match)
        guard !found.isEmpty else {
            note("No audio process matches \"\(match)\". Try: ilcapture list")
            exit(2)
        }
        note("Tapping: " + found.map { "\($0.name) (\($0.pid))" }.joined(separator: ", "))
        return found.map(\.objectID)
    }

    if !o.systemPIDs.isEmpty {
        let found = AudioProcesses.matching(pids: o.systemPIDs)
        guard !found.isEmpty else {
            note("No audio process objects for pids \(o.systemPIDs). Try: ilcapture list")
            exit(2)
        }
        note("Tapping: " + found.map { "\($0.name) (\($0.pid))" }.joined(separator: ", "))
        return found.map(\.objectID)
    }

    usage()
}

func runCapture(_ o: Options) async -> Never {
    let targets = resolveTapTargets(o)

    let interviewerMeter = LevelMeter()
    let candidateMeter = LevelMeter()

    let transcriber = try? await DualTranscriber(locale: o.locale, writer: writer)
    if transcriber == nil {
        writer.emit(
            .status(
                code: .modelUnavailable,
                message:
                    "on-device speech model unavailable for \(o.locale); capture will run without transcription"
            ))
    }

    // System audio → interviewer channel.
    let tap = SystemAudioTap { buffer in
        interviewerMeter.accumulate(buffer)
        transcriber?.feed(buffer, into: .interviewer)
    }
    do {
        try tap.start(processObjectIDs: targets)
    } catch {
        writer.emit(.status(code: .captureError, message: String(describing: error)))
        exit(3)
    }

    // Microphone → candidate channel. A missing microphone degrades the
    // session to interviewer-only rather than failing it: the interviewer
    // channel is the one that carries the questions.
    var mic: MicCapture?
    var micLive = false
    if o.useMic {
        switch MicCapture.currentAccess() {
        case .granted:
            let m = MicCapture { buffer in
                candidateMeter.accumulate(buffer)
                transcriber?.feed(buffer, into: .candidate)
            }
            do {
                try m.start()
                mic = m
                micLive = true
            } catch {
                writer.emit(.status(code: .captureError, message: String(describing: error)))
            }
        case .denied:
            writer.emit(
                .status(
                    code: .micPermissionDenied,
                    message: "microphone access denied; continuing with the interviewer channel only"
                ))
        case .notDetermined:
            writer.emit(
                .status(
                    code: .micPermissionDenied,
                    message:
                        "microphone access not yet granted; run `ilcapture request-mic` once, then restart. Continuing with the interviewer channel only"
                ))
        }
    }

    writer.emit(
        .ready(
            sampleRate: tap.format?.sampleRate ?? 0,
            channels: micLive ? [.interviewer, .candidate] : [.interviewer],
            locale: o.locale))

    // Clean shutdown on SIGINT/SIGTERM so the tap and aggregate device are
    // always torn down — a leaked private aggregate device is invisible but real.
    let stopping = ManagedAtomicFlag()
    for sig in [SIGINT, SIGTERM] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { stopping.set() }
        source.resume()
        signalSources.append(source)
    }

    let deadline = o.seconds.map { Date().addingTimeInterval($0) }
    var reportedSilence = false

    while !stopping.isSet {
        if let deadline, Date() >= deadline { break }
        try? await Task.sleep(for: .milliseconds(500))

        let interviewer = interviewerMeter.drain()
        let candidate = candidateMeter.drain()
        writer.emit(.level(channel: .interviewer, rms: interviewer.rms, peak: interviewer.peak))
        if micLive {
            writer.emit(.level(channel: .candidate, rms: candidate.rms, peak: candidate.peak))
        }

        // Report a silent system-audio stream once — callbacks arriving with
        // nothing but zeroes is what a missing permission looks like.
        if interviewer.isSilent, !reportedSilence {
            reportedSilence = true
            writer.emit(
                .status(
                    code: .systemAudioSilent,
                    message:
                        "system audio is delivering silence — check System Settings > Privacy & Security > Screen & System Audio Recording"
                ))
        }
    }

    await transcriber?.finish()
    mic?.stop()
    tap.stop()
    writer.emit(.stopped(reason: stopping.isSet ? "signal" : "duration"))
    exit(0)
}

/// Minimal flag usable from a signal handler context.
final class ManagedAtomicFlag: @unchecked Sendable {
    private var value = false
    private let lock = NSLock()
    var isSet: Bool { lock.withLock { value } }
    func set() { lock.withLock { value = true } }
}

nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []

// MARK: - Entry

setvbuf(stdout, nil, _IOLBF, 0)

let argv = Array(CommandLine.arguments.dropFirst())
switch argv.first {
case "list":
    runList()
case "request-mic":
    let access = await MicCapture.promptForAccess()
    switch access {
    case .granted: note("microphone access granted"); exit(0)
    case .denied:
        note("microphone access denied — grant it in System Settings > Privacy & Security > Microphone")
        exit(1)
    case .notDetermined: note("no answer to the microphone prompt"); exit(1)
    }
case "capture":
    await runCapture(parseOptions(Array(argv.dropFirst())))
default:
    usage()
}
