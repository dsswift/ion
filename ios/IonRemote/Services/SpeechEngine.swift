import Foundation

// MARK: - SpeechEngine Protocol

/// Abstraction over on-device speech recognition engines.
/// iOS 26+: backed by SpeechAnalyzer/SpeechTranscriber (better model, no time limit).
/// iOS 17–25: backed by SFSpeechRecognizer with requiresOnDeviceRecognition = true.
///
/// All properties and methods must be called on the MainActor.
@MainActor
protocol SpeechEngine: AnyObject {
    /// Whether a recording session is currently active.
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

    /// Stop recording and return the final transcript string.
    /// The caller is responsible for appending it to the input field.
    func stopRecording() -> String

    /// Stop recording and discard the transcript entirely.
    func cancelRecording()
}

// MARK: - Factory

/// Returns the best available on-device speech engine for the current OS version.
/// - iOS 26+: `ModernSpeechEngine` (SpeechAnalyzer/SpeechTranscriber)
/// - iOS 17–25: `LegacySpeechEngine` (SFSpeechRecognizer)
@MainActor
func makeSpeechEngine() -> any SpeechEngine {
    if #available(iOS 26, *) {
        DiagnosticLog.log("SPEECH-FACTORY: selecting ModernSpeechEngine (iOS 26+)")
        return ModernSpeechEngine()
    } else {
        DiagnosticLog.log("SPEECH-FACTORY: selecting LegacySpeechEngine (iOS 17–25)")
        return LegacySpeechEngine()
    }
}
