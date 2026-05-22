import Foundation
import Speech
import AVFoundation
import Observation

// MARK: - LegacySpeechEngine

/// SFSpeechRecognizer-based on-device speech recognition for iOS 17–25.
/// Uses requiresOnDeviceRecognition = true so no audio ever leaves the device.
/// Practical limit: ~1 minute per session (fine for voice prompts).
@Observable
@MainActor
final class LegacySpeechEngine: SpeechEngine {

    private(set) var isRecording = false
    private(set) var transcript = ""
    private(set) var audioLevel: Float = 0
    private(set) var errorMessage: String?

    private let recognizer: SFSpeechRecognizer?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private let audioEngine = AVAudioEngine()

    // Throttle audio level updates: timestamp of last MainActor dispatch
    private var lastLevelUpdate: CFAbsoluteTime = 0

    // SFSpeechRecognizer's result.bestTranscription.formattedString is already the
    // FULL running transcript for the recognition task — it does not reset at
    // utterance boundaries the way SpeechTranscriber's progressive results do.
    // So this engine needs no utterance accumulation: each result simply replaces
    // the current transcript wholesale. (The leading-space heuristic the modern
    // engine used to use was wrong there too and is gone — see applyResult in
    // ModernSpeechEngine for the full explanation.)

    init() {
        recognizer = SFSpeechRecognizer(locale: .current)
        DiagnosticLog.log("SPEECH-LEGACY: init locale=\(Locale.current.identifier) available=\(recognizer?.isAvailable == true)")
    }

    // MARK: - SpeechEngine

    func startRecording() async throws {
        DiagnosticLog.log("SPEECH-LEGACY: startRecording called")
        guard !isRecording else {
            DiagnosticLog.log("SPEECH-LEGACY: already recording, ignoring start")
            return
        }

        guard let recognizer, recognizer.isAvailable else {
            let msg = "Speech recognizer unavailable for locale \(Locale.current.identifier)"
            DiagnosticLog.log("SPEECH-LEGACY: error — \(msg)")
            errorMessage = msg
            throw SpeechEngineError.recognizerUnavailable
        }

        // Configure audio session for recording
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            DiagnosticLog.log("SPEECH-LEGACY: audio session configured for recording")
        } catch {
            DiagnosticLog.log("SPEECH-LEGACY: audio session error: \(error.localizedDescription)")
            throw error
        }

        // Build recognition request
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        recognitionRequest = request

        // Reset transcript for this session — see comment above the engine type
        // for why no separate accumulation state is needed.
        transcript = ""
        DiagnosticLog.log("SPEECH-LEGACY: transcript reset on startRecording")

        // Install audio tap — callback runs on an AVAudioEngine internal thread
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            guard let self else { return }
            self.recognitionRequest?.append(buffer)
            // Throttle level updates to ~20fps
            let now = CFAbsoluteTimeGetCurrent()
            if now - self.lastLevelUpdate > 0.05 {
                self.lastLevelUpdate = now
                let level = Self.rmsLevel(from: buffer)
                Task { @MainActor [weak self] in self?.audioLevel = level }
            }
        }

        audioEngine.prepare()
        try audioEngine.start()
        DiagnosticLog.log("SPEECH-LEGACY: audio engine started")

        // transcript was already cleared above; just flip the live state flags here.
        errorMessage = nil
        isRecording = true

        // Start recognition task.
        // The callback is delivered on an internal Speech framework thread —
        // all self access must hop to MainActor explicitly.
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let rawSegment = result.bestTranscription.formattedString
                let isFinal = result.isFinal
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    DiagnosticLog.log("SPEECH-LEGACY: result isFinal=\(isFinal) segment=\(rawSegment.prefix(60))")
                    self.applyResult(rawSegment)
                }
            }
            if let error {
                let nsErr = error as NSError
                // Code 1110 = "no speech detected" — normal during cancellation
                let isSilence = nsErr.domain == "kAFAssistantErrorDomain" && nsErr.code == 1110
                let isCancelled = nsErr.domain == NSCocoaErrorDomain && nsErr.code == NSUserCancelledError
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if !isSilence && !isCancelled {
                        DiagnosticLog.log("SPEECH-LEGACY: recognition error: \(error.localizedDescription)")
                        self.errorMessage = error.localizedDescription
                    }
                    if self.isRecording {
                        self.teardown(deactivateSession: true)
                    }
                }
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioInterruptionOnMainThread(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        DiagnosticLog.log("SPEECH-LEGACY: recognition task started, isRecording=true")
    }

    func stopRecording() -> String {
        DiagnosticLog.log("SPEECH-LEGACY: stopRecording — final transcript=\(transcript.prefix(80))")
        let final = transcript
        teardown(deactivateSession: true)
        return final
    }

    func cancelRecording() {
        DiagnosticLog.log("SPEECH-LEGACY: cancelRecording — discarding transcript=\(transcript.prefix(40))")
        teardown(deactivateSession: true)
        transcript = ""
    }

    // MARK: - Result application

    /// SFSpeechRecognizer's bestTranscription.formattedString is always the COMPLETE
    /// running transcript for the recognition task, not a delta — so each result simply
    /// replaces the current transcript wholesale. No utterance-boundary detection,
    /// no leading-space heuristics, no accumulation buffers required.
    private func applyResult(_ rawSegment: String) {
        transcript = rawSegment
    }

    // MARK: - Teardown

    private func teardown(deactivateSession: Bool) {
        DiagnosticLog.log("SPEECH-LEGACY: teardown deactivate=\(deactivateSession)")

        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil

        if audioEngine.isRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }

        if deactivateSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }

        NotificationCenter.default.removeObserver(
            self,
            name: AVAudioSession.interruptionNotification,
            object: nil
        )

        isRecording = false
        audioLevel = 0
        DiagnosticLog.log("SPEECH-LEGACY: teardown complete")
    }

    @objc nonisolated private func handleAudioInterruptionOnMainThread(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        DiagnosticLog.log("SPEECH-LEGACY: audio interruption type=\(typeValue)")
        guard type == .began else { return }
        Task { @MainActor [weak self] in
            guard let self, self.isRecording else { return }
            self.teardown(deactivateSession: false)
        }
    }

    // MARK: - Audio level (called from tap thread — no actor isolation)

    private static func rmsLevel(from buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData else { return 0 }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return 0 }
        let ptr = channelData.pointee
        var sum: Float = 0
        for i in 0..<frameCount { sum += ptr[i] * ptr[i] }
        let rms = (sum / Float(frameCount)).squareRoot()
        let avgPower = 20 * log10(max(rms, 1e-7))
        let minDb: Float = -60
        return max(0, min(1, (avgPower - minDb) / (-minDb)))
    }
}

// MARK: - Error Types

enum SpeechEngineError: Error, LocalizedError {
    case recognizerUnavailable
    case permissionDenied
    case audioSessionFailed(String)

    var errorDescription: String? {
        switch self {
        case .recognizerUnavailable: return "Speech recognition is not available for your current language."
        case .permissionDenied: return "Microphone or speech recognition permission was denied."
        case .audioSessionFailed(let msg): return "Audio session error: \(msg)"
        }
    }
}
