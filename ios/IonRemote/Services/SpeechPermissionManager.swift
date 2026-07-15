import Foundation
import Speech
import AVFoundation

// MARK: - SpeechPermissionManager

/// Manages microphone and speech recognition permission requests.
/// Both the legacy (SFSpeechRecognizer) and modern (SpeechAnalyzer) paths use the
/// same underlying permission keys: NSMicrophoneUsageDescription and
/// NSSpeechRecognitionUsageDescription.
@MainActor
final class SpeechPermissionManager {

    // MARK: - State

    enum PermissionState: Equatable {
        case notDetermined
        case granted
        case denied
        case restricted
    }

    private(set) var microphoneState: PermissionState = .notDetermined
    private(set) var speechState: PermissionState = .notDetermined

    var isFullyGranted: Bool {
        microphoneState == .granted && speechState == .granted
    }

    var isDenied: Bool {
        microphoneState == .denied || speechState == .denied ||
        microphoneState == .restricted || speechState == .restricted
    }

    // MARK: - Init

    init() {
        refreshCurrentStatus()
        DiagnosticLog.log("speech permission init", tag: "speech.permission", fields: [
            "mic": String(describing: microphoneState),
            "speech": String(describing: speechState)
        ])
    }

    // MARK: - Public API

    /// Request both microphone and speech recognition permissions.
    /// Returns true only when both are granted.
    func requestAll() async -> Bool {
        DiagnosticLog.log("speech permission requestAll called", tag: "speech.permission")
        let mic = await requestMicrophone()
        let speech = await requestSpeechRecognition()
        DiagnosticLog.log("speech permission requested", tag: "speech.permission", fields: [
            "mic": String(mic),
            "speech": String(speech),
            "combined": String(mic && speech)
        ])
        return mic && speech
    }

    /// Refresh permission states from current system values (no prompt).
    func refreshCurrentStatus() {
        microphoneState = currentMicState()
        speechState = currentSpeechState()
    }

    // MARK: - Private

    private func requestMicrophone() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            microphoneState = .granted
            DiagnosticLog.log("microphone already granted", tag: "speech.permission")
            return true
        case .denied:
            microphoneState = .denied
            DiagnosticLog.log("microphone denied", tag: "speech.permission")
            return false
        case .undetermined:
            DiagnosticLog.log("requesting microphone permission", tag: "speech.permission")
            // AVAudioApplication.requestRecordPermission() is already async and
            // resumes on the calling actor — no continuation wrapping needed.
            let granted = await AVAudioApplication.requestRecordPermission()
            microphoneState = granted ? .granted : .denied
            DiagnosticLog.log("microphone permission result", tag: "speech.permission", fields: [
                "result": String(granted)
            ])
            return granted
        @unknown default:
            microphoneState = .denied
            return false
        }
    }

    private func requestSpeechRecognition() async -> Bool {
        let current = SFSpeechRecognizer.authorizationStatus()
        DiagnosticLog.log("speech recognizer current status", tag: "speech.permission", fields: [
            "status": String(current.rawValue)
        ])
        switch current {
        case .authorized:
            speechState = .granted
            return true
        case .denied:
            speechState = .denied
            return false
        case .restricted:
            speechState = .restricted
            return false
        case .notDetermined:
            DiagnosticLog.log("requesting speech recognition permission", tag: "speech.permission")
            // SFSpeechRecognizer.requestAuthorization calls back on an arbitrary
            // thread. We must NOT hop back to MainActor inside the continuation —
            // that causes a deadlock because the MainActor is suspended waiting for
            // resume, and a Task { @MainActor } can't run until it's already resumed.
            // Instead resume directly from the callback thread; the caller will
            // naturally resume on the MainActor when the await returns.
            let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status)
                }
            }
            DiagnosticLog.log("speech recognition permission result", tag: "speech.permission", fields: [
                "status": String(status.rawValue)
            ])
            switch status {
            case .authorized:
                speechState = .granted
                return true
            case .denied:
                speechState = .denied
                return false
            case .restricted:
                speechState = .restricted
                return false
            case .notDetermined:
                speechState = .notDetermined
                return false
            @unknown default:
                speechState = .denied
                return false
            }
        @unknown default:
            speechState = .denied
            return false
        }
    }

    private func currentMicState() -> PermissionState {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        case .undetermined: return .notDetermined
        @unknown default: return .denied
        }
    }

    private func currentSpeechState() -> PermissionState {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .denied
        }
    }
}
