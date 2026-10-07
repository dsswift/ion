import Foundation
import Observation
import UIKit

// MARK: - SpeechRecognitionService

/// Observable wrapper that owns the SpeechEngine and SpeechPermissionManager,
/// and the one dictation session the composer can have open.
///
/// Selects the best available engine at init time (iOS 26+: modern, iOS 17–25:
/// legacy). Exposed on SessionViewModel so the composer can bind to the
/// dictation phase, the live transcript, and the audio level.
///
/// The dictation session lives here rather than in the composer view because
/// the view used to keep its own "recording" flag beside the engine's. The two
/// drifted whenever the engine ended a session on its own (an interruption, a
/// recognizer error, the legacy one-minute limit): the engine was idle while
/// the composer still showed the recording strip and its stop button had
/// nothing to stop. One owner, one phase.
@Observable
@MainActor
final class SpeechRecognitionService {

    // MARK: - Dictation session

    /// Where a dictation is in its life. `starting` covers the permission
    /// prompt and the engine's audio setup, which on first use can take long
    /// enough to show; `finishing` covers the recognizer committing its tail
    /// after the operator tapped Done or Send.
    enum DictationPhase: Equatable {
        case idle
        case starting
        case listening
        case finishing
    }

    private(set) var phase: DictationPhase = .idle {
        didSet {
            guard isDictating != (oldValue != .idle) else { return }
            DiagnosticLog.log("dictation screen awake", tag: "speech.recognition", fields: [
                "awake": String(isDictating),
                "phase": String(describing: phase)
            ])
            keepScreenAwake(isDictating)
        }
    }

    /// The composer text that was present when dictation began. Dictated words
    /// are appended after it; Cancel restores exactly this.
    private(set) var baseDraft = ""

    /// When the engine began listening, for the elapsed counter in the strip.
    private(set) var startedAt: Date?

    /// Any phase other than idle: the composer is in its dictation layout.
    var isDictating: Bool { phase != .idle }

    // MARK: - Forwarded state (from engine)

    var isRecording: Bool { engine.isRecording }
    var transcript: String { engine.transcript }
    var audioLevel: Float { engine.audioLevel }
    var errorMessage: String? { engine.errorMessage }

    /// The composer text as it should read right now: the pre-dictation draft
    /// followed by whatever has been heard so far.
    var composedDraft: String { Self.compose(base: baseDraft, transcript: transcript) }

    // MARK: - Permission state

    var permissionState: SpeechPermissionManager.PermissionState {
        if permissions.isDenied { return .denied }
        if permissions.isFullyGranted { return .granted }
        return .notDetermined
    }

    // MARK: - Private

    let engine: any SpeechEngine
    let permissions: SpeechPermissionManager

    /// Holds the screen on while a session is open. The system pauses audio
    /// capture when the display sleeps, so letting the idle timer lock the
    /// phone mid-dictation drops every word spoken until it is woken again.
    private let keepScreenAwake: @MainActor (Bool) -> Void

    // MARK: - Init

    init(
        engine: (any SpeechEngine)? = nil,
        permissions: SpeechPermissionManager = SpeechPermissionManager(),
        keepScreenAwake: @escaping @MainActor (Bool) -> Void = { UIApplication.shared.isIdleTimerDisabled = $0 }
    ) {
        self.engine = engine ?? makeSpeechEngine()
        self.permissions = permissions
        self.keepScreenAwake = keepScreenAwake
        DiagnosticLog.log("speech service init", tag: "speech.recognition", fields: [
            "engine": String(describing: type(of: self.engine))
        ])
    }

    // MARK: - Permissions

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

    // MARK: - Dictation lifecycle

    /// Open a dictation session on top of `baseDraft`.
    ///
    /// Stops any in-progress TTS playback first to avoid an audio session
    /// conflict. Requires permission to have been granted already; throws
    /// `SpeechEngineError.permissionDenied` otherwise, and rethrows whatever
    /// the engine throws when its audio setup fails. On any throw the phase is
    /// back at idle.
    func beginDictation(baseDraft: String, stoppingVoiceService voiceService: VoiceService? = nil) async throws {
        guard phase == .idle else {
            DiagnosticLog.log("begin dictation ignored; session open", tag: "speech.recognition", level: .warn, fields: [
                "phase": String(describing: phase)
            ])
            return
        }
        guard permissions.isFullyGranted else {
            DiagnosticLog.log("begin dictation refused; permission not granted", tag: "speech.recognition", level: .warn, fields: [
                "mic": String(describing: permissions.microphoneState),
                "speech": String(describing: permissions.speechState)
            ])
            throw SpeechEngineError.permissionDenied
        }

        self.baseDraft = baseDraft
        phase = .starting
        DiagnosticLog.log("dictation starting", tag: "speech.recognition", fields: [
            "base_count": String(baseDraft.count)
        ])

        // Stop TTS before capturing mic to avoid audio session conflict
        if let vs = voiceService, vs.isSpeaking {
            DiagnosticLog.log("stopping tts before dictation", tag: "speech.recognition")
            vs.stop()
        }

        do {
            try await engine.startRecording()
        } catch {
            phase = .idle
            startedAt = nil
            DiagnosticLog.log("dictation start failed", tag: "speech.recognition", level: .error, fields: [
                "error": error.localizedDescription
            ])
            throw error
        }
        // A Cancel that landed during the engine's async setup already closed
        // the session; the engine was stopped by it, so there is nothing to
        // promote to listening.
        guard phase == .starting else {
            DiagnosticLog.log("dictation cancelled during start", tag: "speech.recognition")
            return
        }
        startedAt = Date()
        phase = .listening
        DiagnosticLog.log("dictation listening", tag: "speech.recognition", fields: [
            "engine": String(describing: type(of: engine))
        ])
    }

    /// Finish the session and return the composed draft: the base text plus
    /// everything the recognizer committed, including the tail it finalizes
    /// after capture stops.
    func finishDictation() async -> String {
        guard phase == .starting || phase == .listening else {
            DiagnosticLog.log("finish dictation ignored", tag: "speech.recognition", fields: [
                "phase": String(describing: phase)
            ])
            return composedDraft
        }
        phase = .finishing
        let final = await engine.stopRecording()
        let composed = Self.compose(base: baseDraft, transcript: final)
        DiagnosticLog.log("dictation finished", tag: "speech.recognition", fields: [
            "transcript_count": String(final.count),
            "composed_count": String(composed.count)
        ])
        closeSession()
        return composed
    }

    /// Discard the session and return the draft to restore.
    func cancelDictation() -> String {
        let restore = baseDraft
        DiagnosticLog.log("dictation cancelled", tag: "speech.recognition", fields: [
            "phase": String(describing: phase),
            "transcript_count": String(transcript.count)
        ])
        engine.cancelRecording()
        closeSession()
        return restore
    }

    /// The engine ended the session without being asked (interruption, error,
    /// time limit). Keep what was heard and return the composed draft so the
    /// composer settles on the words rather than on a stuck recording strip.
    func settleAfterEngineEnded() -> String {
        let composed = composedDraft
        DiagnosticLog.log("dictation ended by engine", tag: "speech.recognition", level: .warn, fields: [
            "phase": String(describing: phase),
            "composed_count": String(composed.count),
            "error": errorMessage ?? ""
        ])
        closeSession()
        return composed
    }

    private func closeSession() {
        phase = .idle
        startedAt = nil
        baseDraft = ""
    }

    // MARK: - Composition

    /// The composer text for a base draft plus dictated words: one space
    /// between them when both are present, no stray separators otherwise.
    static func compose(base: String, transcript: String) -> String {
        let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return base }
        guard !base.isEmpty else { return spoken }
        let needsSeparator = !(base.last?.isWhitespace ?? false)
        return base + (needsSeparator ? " " : "") + spoken
    }
}
