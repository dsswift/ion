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

    private(set) var isSpeaking = false

    private var audioPlayer: AVAudioPlayer?
    private var speakTask: Task<Void, Never>?
    private var pendingText: String?

    private static let keychainService = "com.ion.remote.elevenlabs"
    private static let voiceID = "21m00Tcm4TlvDq8ikWAM"  // Rachel (default)
    private static let modelID = "eleven_turbo_v2_5"

    private var apiKey: String? {
        KeychainHelper.get(VoiceService.keychainService)
    }

    func speak(text: String) {
        let cleaned = stripMarkdown(text)
        guard isEnabled, !cleaned.isEmpty else { return }
        if isSpeaking {
            // Replace any earlier queued text; current audio finishes naturally.
            pendingText = cleaned
        } else {
            pendingText = nil
            speakTask = Task { await self.performSpeak(cleaned) }
        }
    }

    func stop() {
        speakTask?.cancel()
        speakTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        isSpeaking = false
        pendingText = nil
    }

    // MARK: - Private

    private func performSpeak(_ text: String) async {
        isSpeaking = true
        defer {
            isSpeaking = false
            if !Task.isCancelled, let pending = pendingText {
                pendingText = nil
                speakTask = Task { await self.performSpeak(pending) }
            }
        }

        guard let audioData = await fetchAudio(text) else { return }
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
        guard let key = apiKey, !key.isEmpty else { return nil }
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
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return data
        } catch {
            return nil
        }
    }

    private func stripMarkdown(_ text: String) -> String {
        var s = text
        s = s.replacingOccurrences(of: #"```[\s\S]*?```"#, with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"`[^`\n]+`"#, with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\*{1,3}([^*\n]+)\*{1,3}"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"(?m)^#{1,6}\s+"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^\)]+\)"#, with: "$1", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
