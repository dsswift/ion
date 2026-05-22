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

    // Utterance accumulation — see applySegment() for the full explanation
    private var finalizedPrefix = ""
    private var lastSegmentText = ""

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
            DiagnosticLog.log("SPEECH-MODERN: audio session configured")
        } catch {
            DiagnosticLog.log("SPEECH-MODERN: audio session error: \(error.localizedDescription)")
            throw error
        }

        // Build the transcriber using the progressiveTranscription preset for live partials
        let t = SpeechTranscriber(locale: .current, preset: .progressiveTranscription)
        transcriber = t
        DiagnosticLog.log("SPEECH-MODERN: SpeechTranscriber created locale=\(Locale.current.identifier)")

        // The input node's natural format is what we tap at (e.g. Float32, 48 kHz).
        // bestAvailableAudioFormat returns the format the transcriber wants (e.g. Int16, 16 kHz).
        // We MUST NOT install the tap in the transcriber format — installTap requires Float32.
        // Instead: tap at natural format, convert buffers before feeding the analyzer.
        let inputNode = audioEngine.inputNode
        let hardwareFormat = inputNode.outputFormat(forBus: 0)
        DiagnosticLog.log("SPEECH-MODERN: hardware format sampleRate=\(hardwareFormat.sampleRate) channels=\(hardwareFormat.channelCount) commonFormat=\(hardwareFormat.commonFormat.rawValue)")

        let transcriberFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [t],
            considering: hardwareFormat
        ) ?? hardwareFormat
        DiagnosticLog.log("SPEECH-MODERN: transcriber format sampleRate=\(transcriberFormat.sampleRate) channels=\(transcriberFormat.channelCount) commonFormat=\(transcriberFormat.commonFormat.rawValue)")

        // Set up converter only when the formats differ
        if hardwareFormat != transcriberFormat {
            guard let conv = AVAudioConverter(from: hardwareFormat, to: transcriberFormat) else {
                let msg = "Failed to create AVAudioConverter from \(hardwareFormat) to \(transcriberFormat)"
                DiagnosticLog.log("SPEECH-MODERN: error — \(msg)")
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
        finalizedPrefix = ""
        lastSegmentText = ""
        transcript = ""
        errorMessage = nil
        isRecording = true

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
            DiagnosticLog.log("SPEECH-MODERN: audio engine started, transcription task launched")
        } catch {
            DiagnosticLog.log("SPEECH-MODERN: audioEngine.start() threw: \(error.localizedDescription)")
            finishInputAndTeardown()
            throw error
        }
    }

    func stopRecording() -> String {
        DiagnosticLog.log("SPEECH-MODERN: stopRecording — final transcript=\(transcript.prefix(80))")
        let final = transcript
        finishInputAndTeardown()
        return final
    }

    func cancelRecording() {
        DiagnosticLog.log("SPEECH-MODERN: cancelRecording")
        finishInputAndTeardown()
        finalizedPrefix = ""
        lastSegmentText = ""
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
                        DiagnosticLog.log("SPEECH-MODERN: analyzeSequence complete")
                    } catch {
                        DiagnosticLog.log("SPEECH-MODERN: analyzeSequence error: \(error.localizedDescription)")
                    }
                }

                group.addTask { [weak self] in
                    guard let self else { return }
                    do {
                        for try await result in transcriber.results {
                            let segmentText = String(result.text.characters)
                            DiagnosticLog.log("SPEECH-MODERN: result segment=\(segmentText.prefix(60))")
                            await MainActor.run { self.applySegment(segmentText) }
                        }
                    } catch {
                        DiagnosticLog.log("SPEECH-MODERN: transcriber.results error: \(error.localizedDescription)")
                        await MainActor.run { self.errorMessage = error.localizedDescription }
                    }
                    DiagnosticLog.log("SPEECH-MODERN: results loop ended")
                }
            }
        } catch {
            DiagnosticLog.log("SPEECH-MODERN: SpeechAnalyzer init error: \(error.localizedDescription)")
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

    /// Apply a new segment result, accumulating across utterance boundaries.
    ///
    /// SpeechTranscriber with progressiveTranscription delivers each utterance window
    /// as a series of replaceable partials. When a new utterance begins after a pause
    /// the result arrives with a leading space (e.g. " Okay" after "...read ").
    /// That leading space is the reliable reset signal — not a length comparison,
    /// which breaks whenever the new utterance happens to be shorter than the last.
    ///
    /// On reset: commit lastSegmentText to finalizedPrefix, then start fresh.
    /// transcript = finalizedPrefix + trimmed currentSegment at all times.
    private func applySegment(_ rawSegment: String) {
        let isNewUtterance = rawSegment.hasPrefix(" ") && !lastSegmentText.isEmpty
        let segmentText = rawSegment.trimmingCharacters(in: .whitespaces)

        if isNewUtterance {
            if !lastSegmentText.isEmpty {
                let sep = finalizedPrefix.isEmpty ? "" : " "
                finalizedPrefix += sep + lastSegmentText
                DiagnosticLog.log("SPEECH-MODERN: committed utterance prefix=\(finalizedPrefix.prefix(60))")
            }
        }

        lastSegmentText = segmentText
        let sep = (finalizedPrefix.isEmpty || segmentText.isEmpty) ? "" : " "
        transcript = finalizedPrefix + sep + segmentText
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
        DiagnosticLog.log("SPEECH-MODERN: audio interruption type=\(typeValue)")
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
