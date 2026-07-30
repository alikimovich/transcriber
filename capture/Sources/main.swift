// ilcapture — the capture helper for Interview Lens.
//
// Taps system audio (them) and the microphone (me), transcribes both
// on-device, optionally records both to one stereo AAC file, and writes one
// JSON object per line to stdout. It has no UI and no network access; the CLI
// drives it.

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
    var recordPath: String?
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
        case "--record":
            i += 1
            if i < args.count { o.recordPath = args[i] }
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
              --record <path>        also write a stereo AAC .m4a to <path>
                                     (left = me / mic, right = them / system)

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

    let themMeter = LevelMeter()
    let meMeter = LevelMeter()

    // Decide the channel set before building the transcriber: each channel
    // pipeline is expensive to construct, so don't build one we won't feed.
    let micAccess = o.useMic ? MicCapture.currentAccess() : .denied
    var wantedChannels: [Channel] = [.them]
    if micAccess == .granted { wantedChannels.append(.me) }

    let startedAt = Date()
    let transcriber = try? await DualTranscriber(
        locale: o.locale, channels: wantedChannels, writer: writer)
    if transcriber == nil {
        writer.emit(
            .status(
                code: .modelUnavailable,
                message:
                    "on-device speech model unavailable for \(o.locale); capture will run without transcription"
            ))
    }
    note(String(format: "transcriber ready in %.1fs", Date().timeIntervalSince(startedAt)))

    // Optional stereo recording (left = me / mic, right = them / system). A
    // failed open reports a status and leaves `recorder` nil, so capture
    // continues without recording rather than failing the session.
    let recorder = o.recordPath.flatMap { AudioRecorder(path: $0, writer: writer) }

    // System audio → them channel. Fan the same buffers out to the meter, the
    // transcriber, and (if recording) the right channel of the file.
    let tap = SystemAudioTap { buffer in
        themMeter.accumulate(buffer)
        transcriber?.feed(buffer, into: .them)
        recorder?.feed(buffer, into: .them)
    }
    var systemAudioLive = false
    let tapStartedAt = Date()
    do {
        systemAudioLive = try await tap.startVerified(
            processObjectIDs: targets, meter: themMeter)
    } catch {
        writer.emit(.status(code: .captureError, message: String(describing: error)))
        exit(3)
    }
    note(String(format: "tap verified in %.1fs (live: %@)",
        Date().timeIntervalSince(tapStartedAt), systemAudioLive ? "yes" : "no"))
    if !systemAudioLive {
        writer.emit(
            .status(
                code: .systemAudioSilent,
                message:
                    "system audio is delivering silence. If the target app is playing sound, check System Settings > Privacy & Security > Screen & System Audio Recording"
            ))
    }

    // Microphone → me channel. A missing microphone degrades the session to
    // them-only rather than failing it: the system (them) channel is the one
    // that carries the questions.
    var mic: MicCapture?
    var micLive = false
    switch micAccess {
    case .granted:
        let m = MicCapture { buffer in
            meMeter.accumulate(buffer)
            transcriber?.feed(buffer, into: .me)
            recorder?.feed(buffer, into: .me)
        }
        do {
            try m.start()
            mic = m
            micLive = true
        } catch {
            writer.emit(.status(code: .captureError, message: String(describing: error)))
        }
    case .denied where o.useMic:
        writer.emit(
            .status(
                code: .micPermissionDenied,
                message: "microphone access denied; continuing with the them channel only"))
    case .notDetermined:
        writer.emit(
            .status(
                code: .micPermissionDenied,
                message:
                    "microphone access not yet granted; run `ilcapture request-mic` once, then restart. Continuing with the them channel only"
            ))
    default:
        break
    }

    writer.emit(
        .ready(
            sampleRate: tap.format?.sampleRate ?? 0,
            channels: micLive ? [.them, .me] : [.them],
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
    var reportedSilence = !systemAudioLive
    var systemEverLive = systemAudioLive
    let loopStart = Date()
    var micPeakEver = 0.0
    var reportedMicSilence = false

    while !stopping.isSet {
        if let deadline, Date() >= deadline { break }
        try? await Task.sleep(for: .milliseconds(500))

        let them = themMeter.drain()
        let me = meMeter.drain()
        writer.emit(.level(channel: .them, rms: them.rms, peak: them.peak))
        if micLive {
            writer.emit(.level(channel: .me, rms: me.rms, peak: me.peak))
            micPeakEver = max(micPeakEver, me.peak)

            // A granted, running microphone delivering pure zeros for this long
            // is a real failure, not a quiet room — a quiet room still has a
            // noise floor. Usual culprits: the default input is a device with
            // no actual mic, or macOS attributed the mic permission to the
            // terminal app that launched us and that app lacks the grant. This
            // shipped once as a session with me at exactly 0.000 throughout.
            if micPeakEver == 0, !reportedMicSilence,
                Date().timeIntervalSince(loopStart) > 8
            {
                reportedMicSilence = true
                writer.emit(
                    .status(
                        code: .captureError,
                        message:
                            "the microphone is running but delivering pure silence — check which input device is selected in System Settings > Sound, and that your terminal app has microphone access in Privacy & Security > Microphone"
                    ))
            }
        }

        // Report a silent system-audio stream once, and only while the tap has
        // NEVER been live this run — that is what a dead tap or a missing
        // permission looks like. Once audio has flowed, silence is somebody not
        // talking: reporting it made the supervisor restart a healthy capture
        // mid-call, which truncated the recording. `system_audio_silent` is a
        // born-dead signal, nothing else.
        if them.peak > 0 { systemEverLive = true }
        if them.isSilent, !reportedSilence, !systemEverLive {
            reportedSilence = true
            writer.emit(
                .status(
                    code: .systemAudioSilent,
                    message:
                        "system audio is delivering silence — check System Settings > Privacy & Security > Screen & System Audio Recording"
                ))
        }
    }

    let teardownAt = Date()
    await transcriber?.finish()
    note(String(format: "transcriber finish took %.1fs", Date().timeIntervalSince(teardownAt)))
    mic?.stop()
    tap.stop()
    // Flush and close the recording after the callbacks have stopped, so no
    // more samples arrive during the final drain. Bounded and quick.
    recorder?.finish()
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
