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
        DiagnosticLog.log("SPEECH-SVC: init engine=\(type(of: engine))")
    }

    // MARK: - Public API

    /// Request all required permissions. Returns true only when both mic and speech are granted.
    func requestPermission() async -> Bool {
        DiagnosticLog.log("SPEECH-SVC: requestPermission")
        return await permissions.requestAll()
    }

    /// Refreshes cached permission states without prompting.
    func refreshPermissions() {
        permissions.refreshCurrentStatus()
        DiagnosticLog.log("SPEECH-SVC: refreshPermissions mic=\(permissions.microphoneState) speech=\(permissions.speechState)")
    }

    /// Begin recording. Stops any in-progress TTS playback first to avoid audio session conflicts.
    /// Call requestPermission() before this — throws SpeechEngineError.permissionDenied if not granted.
    func startRecording(stoppingVoiceService voiceService: VoiceService? = nil) async throws {
        DiagnosticLog.log("SPEECH-SVC: startRecording called")
        guard permissions.isFullyGranted else {
            DiagnosticLog.log("SPEECH-SVC: permission not granted — mic=\(permissions.microphoneState) speech=\(permissions.speechState)")
            throw SpeechEngineError.permissionDenied
        }

        // Stop TTS before capturing mic to avoid audio session conflict
        if let vs = voiceService, vs.isSpeaking {
            DiagnosticLog.log("SPEECH-SVC: stopping TTS before starting STT")
            vs.stop()
        }

        DiagnosticLog.log("SPEECH-SVC: delegating to engine=\(type(of: engine))")
        try await engine.startRecording()
        DiagnosticLog.log("SPEECH-SVC: recording started isRecording=\(engine.isRecording)")
    }

    /// Stop recording and return the final transcript.
    func stopRecording() -> String {
        let text = engine.stopRecording()
        DiagnosticLog.log("SPEECH-SVC: stopRecording finalText.count=\(text.count)")
        return text
    }

    /// Cancel recording and discard the transcript.
    func cancelRecording() {
        DiagnosticLog.log("SPEECH-SVC: cancelRecording")
        engine.cancelRecording()
    }
}
