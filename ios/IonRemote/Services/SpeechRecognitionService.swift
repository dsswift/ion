import Foundation
import Observation

// MARK: - SpeechRecognitionService

/// Observable wrapper that owns the SpeechEngine and SpeechPermissionManager.
/// Selects the best available engine at init time (iOS 26+: modern, iOS 17–25: legacy).
/// Exposed on SessionViewModel so InputBar can bind to recording state and transcript.
@Observable
@MainActor
final class SpeechRecognitionService {

    // MARK: - Forwarded state (from engine)

    var isRecording: Bool { engine.isRecording }
    var transcript: String { engine.transcript }
    var audioLevel: Float { engine.audioLevel }
    var errorMessage: String? { engine.errorMessage }

    // MARK: - Permission state

    var permissionState: SpeechPermissionManager.PermissionState {
        if permissions.isDenied { return .denied }
        if permissions.isFullyGranted { return .granted }
        return permissions.microphoneState == .notDetermined ? .notDetermined : .notDetermined
    }

    // MARK: - Private

    let engine: any SpeechEngine
    let permissions = SpeechPermissionManager()

    // MARK: - Init

    init() {
        engine = makeSpeechEngine()
        DiagnosticLog.log("speech service init", tag: "speech.recognition", fields: [
            "engine": String(describing: type(of: engine))
        ])
    }

    // MARK: - Public API

    /// Request all required permissions. Returns true only when both mic and speech are granted.
    func requestPermission() async -> Bool {
        DiagnosticLog.log("speech service request permission", tag: "speech.recognition")
        return await permissions.requestAll()
    }

    /// Refreshes cached permission states without prompting.
    func refreshPermissions() {
        permissions.refreshCurrentStatus()
        DiagnosticLog.log("speech service refresh permissions", tag: "speech.recognition", fields: [
            "mic": String(describing: permissions.microphoneState),
            "speech": String(describing: permissions.speechState)
        ])
    }

    /// Begin recording. Stops any in-progress TTS playback first to avoid audio session conflicts.
    /// Call requestPermission() before this — throws SpeechEngineError.permissionDenied if not granted.
    func startRecording(stoppingVoiceService voiceService: VoiceService? = nil) async throws {
        DiagnosticLog.log("speech service start recording called", tag: "speech.recognition")
        guard permissions.isFullyGranted else {
            DiagnosticLog.log("speech service permission not granted", tag: "speech.recognition", level: .warn, fields: [
                "mic": String(describing: permissions.microphoneState),
                "speech": String(describing: permissions.speechState)
            ])
            throw SpeechEngineError.permissionDenied
        }

        // Stop TTS before capturing mic to avoid audio session conflict
        if let vs = voiceService, vs.isSpeaking {
            DiagnosticLog.log("speech service stopping TTS before STT", tag: "speech.recognition")
            vs.stop()
        }

        DiagnosticLog.log("speech service delegating to engine", tag: "speech.recognition", fields: [
            "engine": String(describing: type(of: engine))
        ])
        try await engine.startRecording()
        DiagnosticLog.log("speech service recording started", tag: "speech.recognition", fields: [
            "is_recording": String(engine.isRecording)
        ])
    }

    /// Stop recording and return the final transcript.
    func stopRecording() -> String {
        let text = engine.stopRecording()
        DiagnosticLog.log("speech service stop recording", tag: "speech.recognition", fields: [
            "final_text_count": String(text.count)
        ])
        return text
    }

    /// Cancel recording and discard the transcript.
    func cancelRecording() {
        DiagnosticLog.log("speech service cancel recording", tag: "speech.recognition")
        engine.cancelRecording()
    }
}
