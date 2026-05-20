import AVFoundation
import Foundation
import Observation

// MARK: - VoiceService

@Observable
@MainActor
final class VoiceService {

    var isEnabled: Bool = UserDefaults.standard.bool(forKey: "voiceEnabled") {
        didSet { UserDefaults.standard.set(isEnabled, forKey: "voiceEnabled") }
    }

    enum VoiceMode: String {
        case clientOnly = "client"
        case desktopAssisted = "desktop"

        var label: String {
            switch self {
            case .clientOnly: return "Client-Only"
            case .desktopAssisted: return "Desktop-Assisted"
            }
        }
    }

    var voiceMode: VoiceMode = VoiceMode(rawValue: UserDefaults.standard.string(forKey: "voiceMode") ?? "") ?? .clientOnly {
        didSet { UserDefaults.standard.set(voiceMode.rawValue, forKey: "voiceMode") }
    }

    var voiceSystemPrompt: String = UserDefaults.standard.string(forKey: "voiceSystemPrompt") ?? VoiceService.defaultVoicePrompt {
        didSet { UserDefaults.standard.set(voiceSystemPrompt, forKey: "voiceSystemPrompt") }
    }

    private(set) var isSpeaking = false
    private(set) var speakingMessageId: String?
    private(set) var speakingTabId: String?

    private var audioPlayer: AVAudioPlayer?
    private var speakTask: Task<Void, Never>?
    private var pendingText: String?
    private var pendingMessageId: String?
    private var pendingTabId: String?

    var hasPending: Bool { pendingText != nil }

    private static let keychainService = "com.ion.remote.elevenlabs"
    private static let voiceID = "21m00Tcm4TlvDq8ikWAM" // Rachel (default)
    private static let modelID = "eleven_turbo_v2_5"
    private static let maxSpokenLength = 500

    // swiftlint:disable line_length
    static let defaultVoicePrompt = """
        You are providing voice responses to a mobile user monitoring an AI coding assistant remotely. The user is likely away from their desk — walking, commuting, or multitasking.

        Rules for ALL responses when voice is active:
        - Lead with the outcome: what you did, what happened, whether it worked.
        - One to three sentences maximum. Never exceed four sentences.
        - No code in spoken responses. Say "I edited the function" not the code itself.
        - No file paths longer than the filename. Say "in the auth handler" not "/src/middleware/auth/handler.ts".
        - No lists, bullet points, or structured output. Speak in natural sentences.
        - Use contractions. Sound human.
        - If the task failed, say what went wrong and what you'll try next.
        - If the task succeeded, confirm completion and mention any side effects worth knowing.
        - Never narrate your thinking process. No "Let me look at..." or "I'll now...". Just do it, then report the result.
        """
    // swiftlint:enable line_length

    /// Result of a voice test attempt.
    enum TestResult {
        case success
        case noApiKey
        case httpError(Int)
        case networkError(String)
        case playbackError(String)

        var message: String {
            switch self {
            case .success: return "Voice is working!"
            case .noApiKey: return "No API key configured."
            case .httpError(402): return "Payment required — check your ElevenLabs balance."
            case .httpError(401): return "Invalid API key — check your ElevenLabs key."
            case .httpError(429): return "Rate limited — try again in a moment."
            case .httpError(let code): return "ElevenLabs error (HTTP \(code))."
            case .networkError(let msg): return "Network error: \(msg)"
            case .playbackError(let msg): return "Playback error: \(msg)"
            }
        }

        var isSuccess: Bool {
            if case .success = self { return true }
            return false
        }
    }

    private var apiKey: String? {
        KeychainHelper.get(VoiceService.keychainService)
    }

    func speak(text: String, messageId: String? = nil, tabId: String? = nil) {
        let cleaned = prepareForSpeech(text)
        DiagnosticLog.log("VOICE: speak called, enabled=\(isEnabled) cleaned.count=\(cleaned.count) hasApiKey=\(apiKey != nil)")
        guard isEnabled, !cleaned.isEmpty else {
            DiagnosticLog.log("VOICE: skipped — enabled=\(isEnabled) empty=\(cleaned.isEmpty)")
            return
        }
        if isSpeaking {
            // Replace any earlier queued text; current audio finishes naturally.
            pendingText = cleaned
            pendingMessageId = messageId
            pendingTabId = tabId
            DiagnosticLog.log("VOICE: queued (already speaking)")
        } else {
            pendingText = nil
            DiagnosticLog.log("VOICE: starting performSpeak, text=\(String(cleaned.prefix(80)))…")
            speakTask = Task { await self.performSpeak(cleaned, messageId: messageId, tabId: tabId) }
        }
    }

    func stop() {
        speakTask?.cancel()
        speakTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        isSpeaking = false
        speakingMessageId = nil
        speakingTabId = nil
        pendingText = nil
        pendingMessageId = nil
        pendingTabId = nil
    }

    /// Stop the current audio but let pending speech continue.
    func skip() {
        speakTask?.cancel()
        speakTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        isSpeaking = false
        speakingMessageId = nil
        speakingTabId = nil
        if let pending = pendingText {
            let pMsgId = pendingMessageId
            let pTabId = pendingTabId
            pendingText = nil
            pendingMessageId = nil
            pendingTabId = nil
            speakTask = Task { await self.performSpeak(pending, messageId: pMsgId, tabId: pTabId) }
        }
    }

    /// Test the voice configuration by speaking a short phrase.
    /// Returns a result indicating success or a specific failure reason.
    func testVoice() async -> TestResult {
        guard let key = apiKey, !key.isEmpty else {
            return .noApiKey
        }
        guard let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(Self.voiceID)") else {
            return .networkError("Invalid URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        request.setValue(key, forHTTPHeaderField: "xi-api-key")

        let body: [String: Any] = [
            "text": "Voice is connected and working.",
            "model_id": Self.modelID,
            "voice_settings": ["stability": 0.5, "similarity_boost": 0.75],
        ]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
            return .networkError("Failed to encode request")
        }
        request.httpBody = bodyData

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            return .networkError(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            return .networkError("Unexpected response")
        }
        guard http.statusCode == 200 else {
            return .httpError(http.statusCode)
        }

        // Play the audio
        do {
            #if os(iOS)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: .duckOthers)
            try session.setActive(true)
            defer {
                try? session.setActive(false, options: .notifyOthersOnDeactivation)
            }
            #endif
            let player = try AVAudioPlayer(data: data)
            audioPlayer = player
            player.prepareToPlay()
            player.play()
            while player.isPlaying {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            audioPlayer = nil
            return .success
        } catch {
            audioPlayer = nil
            return .playbackError(error.localizedDescription)
        }
    }

    // MARK: - Private

    private func performSpeak(_ text: String, messageId: String?, tabId: String?) async {
        isSpeaking = true
        speakingMessageId = messageId
        speakingTabId = tabId
        defer {
            isSpeaking = false
            speakingMessageId = nil
            speakingTabId = nil
            if !Task.isCancelled, let pending = pendingText {
                let pMsgId = pendingMessageId
                let pTabId = pendingTabId
                pendingText = nil
                pendingMessageId = nil
                pendingTabId = nil
                speakTask = Task { await self.performSpeak(pending, messageId: pMsgId, tabId: pTabId) }
            }
        }

        guard let audioData = await fetchAudio(text) else {
            DiagnosticLog.log("VOICE: fetchAudio returned nil")
            return
        }
        DiagnosticLog.log("VOICE: got audio data, \(audioData.count) bytes")
        guard !Task.isCancelled else { return }

        do {
            #if os(iOS)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: .duckOthers)
            try session.setActive(true)
            defer {
                try? session.setActive(false, options: .notifyOthersOnDeactivation)
            }
            #endif
            audioPlayer = try AVAudioPlayer(data: audioData)
            audioPlayer?.prepareToPlay()
            audioPlayer?.play()
            while audioPlayer?.isPlaying == true {
                guard !Task.isCancelled else {
                    audioPlayer?.stop()
                    break
                }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        } catch {
            #if DEBUG
            print("[VoiceService] playback error: \(error)")
            #endif
        }

        audioPlayer = nil
    }

    private func fetchAudio(_ text: String) async -> Data? {
        guard let key = apiKey, !key.isEmpty else {
            DiagnosticLog.log("VOICE: no API key in keychain")
            return nil
        }
        guard let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(Self.voiceID)") else {
            return nil
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        request.setValue(key, forHTTPHeaderField: "xi-api-key")

        let body: [String: Any] = [
            "text": text,
            "model_id": Self.modelID,
            "voice_settings": ["stability": 0.5, "similarity_boost": 0.75],
        ]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        request.httpBody = bodyData

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                DiagnosticLog.log("VOICE: ElevenLabs HTTP \(code)")
                return nil
            }
            return data
        } catch {
            DiagnosticLog.log("VOICE: fetch error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Text Preparation

    /// Prepare raw assistant output for speech: strip code, markdown, and cap length.
    private func prepareForSpeech(_ text: String) -> String {
        var s = text
        // Remove fenced code blocks entirely (content and all)
        s = s.replacingOccurrences(of: #"```[\s\S]*?```"#, with: "", options: .regularExpression)
        // Remove inline code
        s = s.replacingOccurrences(of: #"`[^`\n]+`"#, with: "", options: .regularExpression)
        // Strip markdown emphasis
        s = s.replacingOccurrences(of: #"\*{1,3}([^*\n]+)\*{1,3}"#, with: "$1", options: .regularExpression)
        // Strip markdown headings
        s = s.replacingOccurrences(of: #"(?m)^#{1,6}\s+"#, with: "", options: .regularExpression)
        // Strip markdown links, keep label
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^\)]+\)"#, with: "$1", options: .regularExpression)
        // Collapse multiple newlines/spaces
        s = s.replacingOccurrences(of: #"\n{2,}"#, with: ". ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        // Cap length
        if s.count > Self.maxSpokenLength {
            let idx = s.index(s.startIndex, offsetBy: Self.maxSpokenLength)
            s = String(s[..<idx]) + "..."
        }
        return s
    }
}
