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

    /// Identity of the current recording session; see `ModernSpeechEngine` for
    /// the race this closes. The recognizer delivers its final result after
    /// `endAudio()`, asynchronously, and that delivery must not be written into
    /// a session that started after this one ended.
    private var sessionGeneration: UInt64 = 0

    /// Resumed when the recognizer delivers its final result (or fails) after
    /// `stopRecording` ends the audio, so the stop can hand back the committed
    /// transcript rather than the last partial.
    private var finalizeContinuation: CheckedContinuation<Void, Never>?

    // SFSpeechRecognizer's result.bestTranscription.formattedString is already the
    // FULL running transcript for the recognition task — it does not reset at
    // utterance boundaries the way SpeechTranscriber's progressive results do.
    // So this engine needs no utterance accumulation: each result simply replaces
    // the current transcript wholesale. (The leading-space heuristic the modern
    // engine used to use was wrong there too and is gone — see applyResult in
    // ModernSpeechEngine for the full explanation.)

    init() {
        recognizer = SFSpeechRecognizer(locale: .current)
        DiagnosticLog.log("speech legacy init", tag: "speech.legacy", fields: [
            "locale": Locale.current.identifier,
            "available": String(recognizer?.isAvailable == true)
        ])
    }

    // MARK: - SpeechEngine

    func startRecording() async throws {
        DiagnosticLog.log("start recording", tag: "speech.legacy")
        guard !isRecording else {
            DiagnosticLog.log("start recording ignored; already recording", tag: "speech.legacy", level: .warn)
            return
        }

        guard let recognizer, recognizer.isAvailable else {
            let msg = "Speech recognizer unavailable for locale \(Locale.current.identifier)"
            DiagnosticLog.log("speech recognizer unavailable", tag: "speech.legacy", level: .warn, fields: [
                "error": msg
            ])
            errorMessage = msg
            throw SpeechEngineError.recognizerUnavailable
        }

        // Configure audio session for recording
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            DiagnosticLog.log("audio session configured", tag: "speech.legacy")
        } catch {
            DiagnosticLog.log("audio session error", tag: "speech.legacy", level: .error, fields: [
                "error": error.localizedDescription
            ])
            throw error
        }

        // Build recognition request
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        recognitionRequest = request

        // Reset transcript for this session — see comment above the engine type
        // for why no separate accumulation state is needed.
        sessionGeneration &+= 1
        let generation = sessionGeneration
        transcript = ""
        DiagnosticLog.log("transcript state reset", tag: "speech.legacy", fields: [
            "generation": String(generation)
        ])

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
        DiagnosticLog.log("audio engine started", tag: "speech.legacy")

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
                    DiagnosticLog.trace("recognition result", tag: "speech.legacy", fields: [
                        "is_final": String(isFinal),
                        "segment": String(rawSegment.prefix(60))
                    ])
                    self.applyResult(rawSegment, generation: generation)
                    if isFinal { self.resumeFinalize(reason: "final result") }
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
                        DiagnosticLog.log("recognition error", tag: "speech.legacy", level: .error, fields: [
                            "error": error.localizedDescription
                        ])
                        self.errorMessage = error.localizedDescription
                    }
                    self.resumeFinalize(reason: "recognizer ended")
                    if self.isRecording, self.sessionGeneration == generation {
                        // The words heard so far stay in `transcript`: the
                        // caller reads them when it notices `isRecording` fell.
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
        DiagnosticLog.log("recognition task started", tag: "speech.legacy")
    }

    func stopRecording() async -> String {
        guard isRecording else {
            DiagnosticLog.log("stop recording while idle", tag: "speech.legacy", fields: [
                "transcript_count": String(transcript.count)
            ])
            return transcript
        }
        DiagnosticLog.log("stop recording; finalizing", tag: "speech.legacy", fields: [
            "transcript_count": String(transcript.count)
        ])
        // Stop the microphone and tell the recognizer the utterance is over. It
        // answers with one last result flagged final; `resumeFinalize` lets the
        // wait below return the moment that lands.
        if audioEngine.isRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }
        audioLevel = 0
        recognitionRequest?.endAudio()
        let completed = await SpeechEngineFinalize.run { [weak self] in
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                Task { @MainActor [weak self] in
                    guard let self, self.isRecording else {
                        continuation.resume()
                        return
                    }
                    self.finalizeContinuation = continuation
                }
            }
        }
        DiagnosticLog.log(
            completed ? "finalize complete" : "finalize timed out",
            tag: "speech.legacy",
            level: completed ? .info : .warn,
            fields: ["transcript_count": String(transcript.count)]
        )
        let final = transcript
        teardown(deactivateSession: true)
        return final
    }

    func cancelRecording() {
        DiagnosticLog.log("cancel recording", tag: "speech.legacy", fields: [
            "transcript_count": String(transcript.count)
        ])
        teardown(deactivateSession: true)
        transcript = ""
    }

    // MARK: - Result application

    /// SFSpeechRecognizer's bestTranscription.formattedString is always the COMPLETE
    /// running transcript for the recognition task, not a delta — so each result simply
    /// replaces the current transcript wholesale. No utterance-boundary detection,
    /// no leading-space heuristics, no accumulation buffers required.
    private func applyResult(_ rawSegment: String, generation: UInt64) {
        guard generation == sessionGeneration else {
            DiagnosticLog.log("stale recognition result dropped", tag: "speech.legacy", fields: [
                "result_generation": String(generation),
                "generation": String(sessionGeneration)
            ])
            return
        }
        transcript = rawSegment
    }

    /// Let a pending `stopRecording` return. Safe to call when nothing waits.
    private func resumeFinalize(reason: String) {
        guard let continuation = finalizeContinuation else { return }
        finalizeContinuation = nil
        DiagnosticLog.trace("finalize resumed", tag: "speech.legacy", fields: ["reason": reason])
        continuation.resume()
    }

    // MARK: - Teardown

    private func teardown(deactivateSession: Bool) {
        DiagnosticLog.log("teardown", tag: "speech.legacy", fields: [
            "deactivate": String(deactivateSession)
        ])

        resumeFinalize(reason: "teardown")
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil

        if audioEngine.isRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }

        if deactivateSession {
            do {
                try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            } catch {
                DiagnosticLog.log("audio session deactivate failed", tag: "speech.legacy", level: .warn, fields: [
                    "error": error.localizedDescription
                ])
            }
        }

        NotificationCenter.default.removeObserver(
            self,
            name: AVAudioSession.interruptionNotification,
            object: nil
        )

        isRecording = false
        audioLevel = 0
        DiagnosticLog.log("teardown complete", tag: "speech.legacy")
    }

    @objc nonisolated private func handleAudioInterruptionOnMainThread(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        DiagnosticLog.log("audio interruption", tag: "speech.legacy", fields: [
            "type": String(typeValue)
        ])
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
