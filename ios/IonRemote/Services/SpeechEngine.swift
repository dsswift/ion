import Foundation

// MARK: - SpeechEngine Protocol

/// Abstraction over on-device speech recognition engines.
/// iOS 26+: backed by SpeechAnalyzer/SpeechTranscriber (better model, no time limit).
/// iOS 17–25: backed by SFSpeechRecognizer with requiresOnDeviceRecognition = true.
///
/// All properties and methods must be called on the MainActor.
@MainActor
protocol SpeechEngine: AnyObject {
    /// Whether a recording session is currently active. Flips to false on its
    /// own when the engine ends the session itself (an audio interruption, a
    /// recognizer error, or the legacy recognizer's per-session time limit),
    /// so a caller that shows recording state must observe this rather than
    /// remember that it asked for a start.
    var isRecording: Bool { get }

    /// Live partial transcript, updated as audio is processed.
    /// Streams in real-time while recording.
    var transcript: String { get }

    /// Normalized audio level 0–1 for waveform visualization.
    var audioLevel: Float { get }

    /// Non-nil when a recoverable error has occurred.
    var errorMessage: String? { get }

    /// Begin capturing audio and transcribing. Throws if the engine cannot start
    /// (e.g. audio session conflict, model unavailable).
    func startRecording() async throws

    /// Stop capturing and return the finished transcript.
    ///
    /// Capture stops immediately, but the recognizer is given up to
    /// `SpeechEngineFinalize.timeout` to commit the audio it already holds. A
    /// progressive recognizer's last visible words are a speculative guess
    /// until that commit lands, so returning the transcript at the instant of
    /// the tap would hand back a lesser version of what was said.
    func stopRecording() async -> String

    /// Stop recording and discard the transcript entirely.
    func cancelRecording()
}

// MARK: - Finalize budget

/// How long `stopRecording` waits for the recognizer to commit the tail of a
/// recording before returning whatever it has.
///
/// Shared by both engines so the composer's "finishing" moment is the same
/// length regardless of OS version. Long enough for the on-device models to
/// emit their final segment after the input stream ends; short enough that a
/// tap on Done never feels ignored.
enum SpeechEngineFinalize {
    static let timeout: Duration = .milliseconds(1500)

    /// Run `operation` and give up waiting once `timeout` passes. Returns true
    /// when the operation finished in time.
    ///
    /// Not a task group: a group awaits every child before it returns, and the
    /// operations passed here (awaiting another task's value, waiting on a
    /// continuation) do not end on cancellation. The operation is left running
    /// when the timeout wins; the caller's teardown is what completes it.
    static func run(_ operation: @escaping @Sendable () async -> Void) async -> Bool {
        let outcome = OneShotOutcome()
        let work = Task { await operation() }
        let timer = Task {
            // Only CancellationError can surface here, and a cancelled sleep
            // is the operation finishing first, which is the outcome this
            // task exists to lose to.
            // swiftlint:disable:next silent_try_optional
            try? await Task.sleep(for: timeout)
        }
        let completed: Bool = await withCheckedContinuation { continuation in
            Task {
                await work.value
                outcome.resume(continuation, with: true)
            }
            Task {
                await timer.value
                outcome.resume(continuation, with: false)
            }
        }
        timer.cancel()
        return completed
    }

    /// Lets exactly one of two racing tasks resume a continuation.
    private final class OneShotOutcome: @unchecked Sendable {
        private let lock = NSLock()
        private var resumed = false

        func resume(_ continuation: CheckedContinuation<Bool, Never>, with value: Bool) {
            lock.lock()
            defer { lock.unlock() }
            guard !resumed else { return }
            resumed = true
            continuation.resume(returning: value)
        }
    }
}

// MARK: - Factory

/// Returns the best available on-device speech engine for the current OS version.
/// - iOS 26+: `ModernSpeechEngine` (SpeechAnalyzer/SpeechTranscriber)
/// - iOS 17–25: `LegacySpeechEngine` (SFSpeechRecognizer)
@MainActor
func makeSpeechEngine() -> any SpeechEngine {
    if #available(iOS 26, *) {
        DiagnosticLog.log("speech factory selected modern engine", tag: "speech.factory")
        return ModernSpeechEngine()
    } else {
        DiagnosticLog.log("speech factory selected legacy engine", tag: "speech.factory")
        return LegacySpeechEngine()
    }
}
