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

    // Transcript accumulation — see applyResult() for the full explanation.
    // SpeechTranscriber.results emits a mix of:
    //   - finalized chunks (result.isFinal == true): must be APPENDED to finalizedTranscript
    //   - volatile partials (result.isFinal == false): must REPLACE volatileTranscript
    // The public `transcript` is always finalizedTranscript + volatileTranscript.
    private var finalizedTranscript = ""
    private var volatileTranscript = ""

    init() {
        DiagnosticLog.log("SPEECH-MODERN: init (iOS 26+ SpeechAnalyzer)")
    }

    // MARK: - SpeechEngine

    func startRecording() async throws {
        DiagnosticLog.log("SPEECH-MODERN: startRecording called")
        guard !isRecording else {
            DiagnosticLog.log("SPEECH-MODERN: already recording, ignoring start")
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
                try? session.setActive(false, options: .notifyOthersOnDeactivation)
                throw SpeechEngineError.audioSessionFailed(msg)
            }
            converter = conv
            converterOutputFormat = transcriberFormat
            DiagnosticLog.log("SPEECH-MODERN: AVAudioConverter created")
        } else {
            converter = nil
            converterOutputFormat = nil
            DiagnosticLog.log("SPEECH-MODERN: no conversion needed (formats match)")
        }

        // Reset accumulation state for this session
        finalizedTranscript = ""
        volatileTranscript = ""
        transcript = ""
        errorMessage = nil
        isRecording = true
        DiagnosticLog.log("SPEECH-MODERN: transcript state reset on startRecording")

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
            await self.runTranscription(transcriber: capturedTranscriber, inputStream: inputStream)
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
            finishInputAndTeardown()
            throw error
        }
    }

    func stopRecording() -> String {
        // Trim only on extraction — the running transcript may carry leading whitespace
        // from the finalized chunks, which is fine internally but ugly when surfaced.
        let final = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        DiagnosticLog.log("stop recording", tag: "speech.modern", fields: [
            "transcript": String(final.prefix(80))
        ])
        finishInputAndTeardown()
        return final
    }

    func cancelRecording() {
        DiagnosticLog.log("cancel recording", tag: "speech.modern", fields: [
            "finalized": String(finalizedTranscript.prefix(40)),
            "volatile": String(volatileTranscript.prefix(40))
        ])
        finishInputAndTeardown()
        finalizedTranscript = ""
        volatileTranscript = ""
        transcript = ""
    }

    // MARK: - Transcription loop

    private func runTranscription(transcriber: SpeechTranscriber, inputStream: AsyncStream<AnalyzerInput>) async {
        DiagnosticLog.log("SPEECH-MODERN: runTranscription starting")
        do {
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            DiagnosticLog.log("SPEECH-MODERN: SpeechAnalyzer created")

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
                            await MainActor.run { self.applyResult(segmentText, isFinal: isFinal) }
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
        } catch {
            DiagnosticLog.log("speech analyzer init error", tag: "speech.modern", level: .error, fields: [
                "error": error.localizedDescription
            ])
            await MainActor.run {
                self.errorMessage = error.localizedDescription
                self.isRecording = false
            }
        }

        DiagnosticLog.log("SPEECH-MODERN: runTranscription complete")
        await MainActor.run {
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
    private func applyResult(_ segmentText: String, isFinal: Bool) {
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

    private func finishInputAndTeardown() {
        DiagnosticLog.log("SPEECH-MODERN: finishInputAndTeardown")
        inputContinuation?.finish()
        inputContinuation = nil

        transcriptionTask?.cancel()
        transcriptionTask = nil
        transcriber = nil
        converter = nil
        converterOutputFormat = nil

        if audioEngine.isRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)

        isRecording = false
        audioLevel = 0
        DiagnosticLog.log("SPEECH-MODERN: teardown complete")
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
            self.finishInputAndTeardown()
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
            DiagnosticLog.log("SPEECH-MODERN: convert — failed to alloc output buffer")
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
            DiagnosticLog.log("SPEECH-MODERN: convert — AVAudioConverter status=error")
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
