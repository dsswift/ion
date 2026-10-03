import Foundation
import Speech
import AVFoundation
import Observation

// MARK: - ModernSpeechEngine

/// SpeechAnalyzer/SpeechTranscriber-based on-device speech recognition for iOS 26+.
/// Uses Apple's modern speech framework with a better model (no time limit, fully on-device).
/// Streams volatile (partial) results in real-time for live text preview in the input field.
///
/// Audio pipeline:
///   AVAudioEngine input tap (hardware format, Float32)
///     → AVAudioConverter (→ transcriber format, e.g. 16 kHz Int16)
///     → AnalyzerInput stream → SpeechAnalyzer → SpeechTranscriber.results
@available(iOS 26, *)
@Observable
@MainActor
final class ModernSpeechEngine: SpeechEngine {

    private(set) var isRecording = false
    private(set) var transcript = ""
    private(set) var audioLevel: Float = 0
    private(set) var errorMessage: String?

    private let audioEngine = AVAudioEngine()
    private var transcriptionTask: Task<Void, Never>?
    private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
    // Keep strong refs so they aren't deallocated mid-stream
    private var transcriber: SpeechTranscriber?
    private var converter: AVAudioConverter?
    private var converterOutputFormat: AVAudioFormat?
    // Throttle level updates to ~20fps to avoid flooding the main queue
    private var lastLevelUpdate: CFAbsoluteTime = 0

    /// Identity of the current recording session. Every result the results
    /// loop delivers carries the generation it was started under, and
    /// `applyResult` drops a result whose generation is no longer current.
    ///
    /// Without this, a session's last results could land after the session was
    /// cancelled or stopped — the analyzer finalizes asynchronously once its
    /// input ends — and be appended to the NEXT session's transcript, so the
    /// first words of a new dictation were the last words of the previous one.
    private var sessionGeneration: UInt64 = 0

    // Transcript accumulation — see applyResult() for the full explanation.
    // SpeechTranscriber.results emits a mix of:
    //   - finalized chunks (result.isFinal == true): must be APPENDED to finalizedTranscript
    //   - volatile partials (result.isFinal == false): must REPLACE volatileTranscript
    // The public `transcript` is always finalizedTranscript + volatileTranscript.
    private var finalizedTranscript = ""
    private var volatileTranscript = ""

    init() {
        DiagnosticLog.log("speech modern engine init", tag: "speech.modern")
    }

    // MARK: - SpeechEngine

    func startRecording() async throws {
        DiagnosticLog.log("start recording", tag: "speech.modern")
        guard !isRecording else {
            DiagnosticLog.log("start recording ignored; already recording", tag: "speech.modern", level: .warn)
            return
        }

        // Configure audio session
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            DiagnosticLog.log("audio session configured", tag: "speech.modern")
        } catch {
            DiagnosticLog.log("audio session error", tag: "speech.modern", level: .error, fields: [
                "error": error.localizedDescription
            ])
            throw error
        }

        // Build the transcriber using the progressiveTranscription preset for live partials
        let t = SpeechTranscriber(locale: .current, preset: .progressiveTranscription)
        transcriber = t
        DiagnosticLog.log("speech transcriber created", tag: "speech.modern", fields: [
            "locale": Locale.current.identifier
        ])

        // The input node's natural format is what we tap at (e.g. Float32, 48 kHz).
        // bestAvailableAudioFormat returns the format the transcriber wants (e.g. Int16, 16 kHz).
        // We MUST NOT install the tap in the transcriber format — installTap requires Float32.
        // Instead: tap at natural format, convert buffers before feeding the analyzer.
        let inputNode = audioEngine.inputNode
        let hardwareFormat = inputNode.outputFormat(forBus: 0)
        DiagnosticLog.log("hardware audio format", tag: "speech.modern", fields: [
            "sample_rate": String(hardwareFormat.sampleRate),
            "channels": String(hardwareFormat.channelCount),
            "common_format": String(hardwareFormat.commonFormat.rawValue)
        ])

        let transcriberFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [t],
            considering: hardwareFormat
        ) ?? hardwareFormat
        DiagnosticLog.log("transcriber audio format", tag: "speech.modern", fields: [
            "sample_rate": String(transcriberFormat.sampleRate),
            "channels": String(transcriberFormat.channelCount),
            "common_format": String(transcriberFormat.commonFormat.rawValue)
        ])

        // Set up converter only when the formats differ
        if hardwareFormat != transcriberFormat {
            guard let conv = AVAudioConverter(from: hardwareFormat, to: transcriberFormat) else {
                let msg = "Failed to create AVAudioConverter from \(hardwareFormat) to \(transcriberFormat)"
                DiagnosticLog.log("audio converter creation failed", tag: "speech.modern", level: .error, fields: [
                    "error": msg
                ])
                do {
                    try session.setActive(false, options: .notifyOthersOnDeactivation)
                } catch {
                    DiagnosticLog.log("audio session deactivate failed", tag: "speech.modern", level: .warn, fields: [
                        "error": error.localizedDescription
                    ])
                }
                throw SpeechEngineError.audioSessionFailed(msg)
            }
            converter = conv
            converterOutputFormat = transcriberFormat
            DiagnosticLog.log("audio converter created", tag: "speech.modern")
        } else {
            converter = nil
            converterOutputFormat = nil
            DiagnosticLog.log("audio converter not needed; formats match", tag: "speech.modern")
        }

        // Reset accumulation state for this session, and open a new generation
        // so anything the previous session still emits is recognised as stale.
        sessionGeneration &+= 1
        let generation = sessionGeneration
        finalizedTranscript = ""
        volatileTranscript = ""
        transcript = ""
        errorMessage = nil
        isRecording = true
        DiagnosticLog.log("transcript state reset", tag: "speech.modern", fields: [
            "generation": String(generation)
        ])

        // Build async stream to feed audio buffers into the analyzer
        let (inputStream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        inputContinuation = continuation

        // Register for interruption — nonisolated selector, dispatches to MainActor internally
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioInterruptionOnMainThread(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )

        // Launch transcription task
        let capturedTranscriber = t
        transcriptionTask = Task { [weak self] in
            guard let self else { return }
            await self.runTranscription(transcriber: capturedTranscriber, inputStream: inputStream, generation: generation)
        }

        // Install audio tap at hardware format (Float32 — the only format installTap accepts).
        // Convert to the transcriber format inside the tap callback before yielding.
        let capturedConverter = converter
        let capturedOutputFormat = converterOutputFormat
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: hardwareFormat) { [weak self] buffer, time in
            guard let self else { return }

            // Throttle level updates to ~20fps
            let now = CFAbsoluteTimeGetCurrent()
            if now - self.lastLevelUpdate > 0.05 {
                self.lastLevelUpdate = now
                let level = Self.rmsLevel(from: buffer)
                Task { @MainActor [weak self] in self?.audioLevel = level }
            }

            // Convert buffer format if needed, then yield to analyzer
            let analyzerBuffer: AVAudioPCMBuffer
            if let conv = capturedConverter, let outFormat = capturedOutputFormat {
                guard let converted = Self.convert(buffer: buffer, using: conv, to: outFormat) else {
                    return // conversion failure — skip this buffer, don't crash
                }
                analyzerBuffer = converted
            } else {
                analyzerBuffer = buffer
            }
            self.inputContinuation?.yield(AnalyzerInput(buffer: analyzerBuffer))
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
            DiagnosticLog.log("audio engine started", tag: "speech.modern")
        } catch {
            DiagnosticLog.log("audio engine start failed", tag: "speech.modern", level: .error, fields: [
                "error": error.localizedDescription
            ])
            stopCapture()
            teardownSession()
            throw error
        }
    }

    func stopRecording() async -> String {
        guard isRecording else {
            let final = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            DiagnosticLog.log("stop recording while idle", tag: "speech.modern", fields: [
                "transcript_count": String(final.count)
            ])
            return final
        }
        DiagnosticLog.log("stop recording; finalizing", tag: "speech.modern", fields: [
            "finalized_count": String(finalizedTranscript.count),
            "volatile_count": String(volatileTranscript.count)
        ])
        // Stop feeding audio. Ending the input stream is what tells the analyzer
        // to commit the tail it is holding; the results loop then sees the last
        // finalized segment and the stream closes on its own.
        stopCapture()
        if let task = transcriptionTask {
            let completed = await SpeechEngineFinalize.run { await task.value }
            DiagnosticLog.log(
                completed ? "finalize complete" : "finalize timed out",
                tag: "speech.modern",
                level: completed ? .info : .warn,
                fields: ["finalized_count": String(finalizedTranscript.count)]
            )
        }
        teardownSession()
        // Trim only on extraction — the running transcript may carry leading whitespace
        // from the finalized chunks, which is fine internally but ugly when surfaced.
        let final = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        DiagnosticLog.log("stop recording returned", tag: "speech.modern", fields: [
            "transcript_count": String(final.count)
        ])
        return final
    }

    func cancelRecording() {
        DiagnosticLog.log("cancel recording", tag: "speech.modern", fields: [
            "finalized_count": String(finalizedTranscript.count),
            "volatile_count": String(volatileTranscript.count)
        ])
        stopCapture()
        teardownSession()
        finalizedTranscript = ""
        volatileTranscript = ""
        transcript = ""
    }

    // MARK: - Transcription loop

    private func runTranscription(
        transcriber: SpeechTranscriber,
        inputStream: AsyncStream<AnalyzerInput>,
        generation: UInt64
    ) async {
        DiagnosticLog.log("transcription loop starting", tag: "speech.modern", fields: [
            "generation": String(generation)
        ])
        let analyzer = SpeechAnalyzer(modules: [transcriber])

        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                do {
                    _ = try await analyzer.analyzeSequence(inputStream)
                    DiagnosticLog.log("analyze sequence complete", tag: "speech.modern")
                } catch {
                    DiagnosticLog.log("analyze sequence error", tag: "speech.modern", level: .error, fields: [
                        "error": error.localizedDescription
                    ])
                }
            }

            group.addTask { [weak self] in
                guard let self else { return }
                do {
                    for try await result in transcriber.results {
                        let segmentText = String(result.text.characters)
                        let isFinal = result.isFinal
                        DiagnosticLog.trace("transcriber result", tag: "speech.modern", fields: [
                            "is_final": String(isFinal),
                            "segment": String(segmentText.prefix(60))
                        ])
                        await MainActor.run { self.applyResult(segmentText, isFinal: isFinal, generation: generation) }
                    }
                } catch {
                    DiagnosticLog.log("transcriber results error", tag: "speech.modern", level: .error, fields: [
                        "error": error.localizedDescription
                    ])
                    await MainActor.run { self.errorMessage = error.localizedDescription }
                }
                DiagnosticLog.log("results loop ended", tag: "speech.modern")
            }
        }

        DiagnosticLog.log("transcription loop complete", tag: "speech.modern", fields: [
            "generation": String(generation)
        ])
        await MainActor.run {
            // A later session may already be running; only the session that
            // owns this loop may report itself finished.
            guard self.sessionGeneration == generation else { return }
            self.isRecording = false
            self.audioLevel = 0
        }
    }

    /// Apply a new result from SpeechTranscriber, dispatching on isFinal.
    ///
    /// Per Apple's official SpeechAnalyzer/SpeechTranscriber guidance (WWDC25 session 277),
    /// the results stream emits two kinds of results in any interleaved order:
    ///
    ///   - Volatile (isFinal == false): a speculative best-guess for the audio that has not
    ///     yet been committed. The receiver must REPLACE the previous volatile value with
    ///     this one. Multiple volatile results in a row supersede each other.
    ///
    ///   - Finalized (isFinal == true): a confirmed chunk of audio that will not change.
    ///     The receiver must APPEND this to the finalized transcript and CLEAR the
    ///     volatile buffer (otherwise the volatile guess and the final chunk overlap and
    ///     produce duplicates).
    ///
    /// The previous implementation tried to detect utterance boundaries via a leading
    /// space heuristic on the raw string. That heuristic misfires on virtually every
    /// progressive chunk and was the cause of the "I I' I'm I'm not …" duplication bug.
    /// The fix is to trust the explicit isFinal flag the API already provides.
    private func applyResult(_ segmentText: String, isFinal: Bool, generation: UInt64) {
        guard generation == sessionGeneration else {
            DiagnosticLog.log("stale transcriber result dropped", tag: "speech.modern", fields: [
                "result_generation": String(generation),
                "generation": String(sessionGeneration),
                "is_final": String(isFinal)
            ])
            return
        }
        if isFinal {
            // Commit this chunk to the finalized portion and drop the volatile guess.
            // The chunk already carries its leading whitespace (Apple's API contract),
            // so we concatenate directly without adding our own separator.
            finalizedTranscript += segmentText
            volatileTranscript = ""
            DiagnosticLog.trace("committed final chunk", tag: "speech.modern", fields: [
                "finalized": String(finalizedTranscript.prefix(80))
            ])
        } else {
            // Replace the in-flight volatile guess.
            volatileTranscript = segmentText
            DiagnosticLog.trace("replaced volatile", tag: "speech.modern", fields: [
                "volatile": String(segmentText.prefix(60))
            ])
        }
        transcript = finalizedTranscript + volatileTranscript
    }

    // MARK: - Teardown

    /// Stop the microphone and close the analyzer's input. The transcription
    /// task is left alone so it can drain its final results; `teardownSession`
    /// is what ends it.
    private func stopCapture() {
        if audioEngine.isRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }
        inputContinuation?.finish()
        inputContinuation = nil
        audioLevel = 0
    }

    /// Release the session: cancel whatever the transcription task has left to
    /// do, drop the analyzer objects, give the audio session back, and mark the
    /// engine idle.
    private func teardownSession() {
        transcriptionTask?.cancel()
        transcriptionTask = nil
        transcriber = nil
        converter = nil
        converterOutputFormat = nil

        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            DiagnosticLog.log("audio session deactivate failed", tag: "speech.modern", level: .warn, fields: [
                "error": error.localizedDescription
            ])
        }
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)

        isRecording = false
        audioLevel = 0
        DiagnosticLog.log("teardown complete", tag: "speech.modern")
    }

    @objc nonisolated private func handleAudioInterruptionOnMainThread(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        DiagnosticLog.log("audio interruption", tag: "speech.modern", fields: [
            "type": String(typeValue)
        ])
        guard type == .began else { return }
        Task { @MainActor [weak self] in
            guard let self, self.isRecording else { return }
            // The words heard so far stay in `transcript`: the caller reads them
            // when it notices `isRecording` fell, so an interruption never
            // discards a dictation the way a cancel does.
            self.stopCapture()
            self.teardownSession()
        }
    }

    // MARK: - Audio helpers (called from tap thread — no actor isolation)

    /// Convert a PCM buffer from the hardware format to the transcriber's required format.
    /// Returns nil (and logs) on failure rather than crashing.
    private static func convert(
        buffer: AVAudioPCMBuffer,
        using converter: AVAudioConverter,
        to outputFormat: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        // Compute the output frame capacity proportionally
        let inputSampleRate = buffer.format.sampleRate
        let outputSampleRate = outputFormat.sampleRate
        let ratio = outputSampleRate / inputSampleRate
        let outputFrameCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1)

        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outputFrameCapacity) else {
            DiagnosticLog.log("audio convert failed to allocate output buffer", tag: "speech.modern", level: .warn)
            return nil
        }

        var consumedAll = false
        let status = converter.convert(to: outputBuffer, error: nil) { _, outStatus in
            if consumedAll {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumedAll = true
            outStatus.pointee = .haveData
            return buffer
        }

        guard status != .error else {
            DiagnosticLog.log("audio convert returned error status", tag: "speech.modern", level: .warn)
            return nil
        }
        return outputBuffer
    }

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
